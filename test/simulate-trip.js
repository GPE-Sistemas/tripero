#!/usr/bin/env node
/**
 * Script para simular un viaje completo en Tripero
 * Simula un vehículo que:
 * 1. Enciende la ignición
 * 2. Se mueve por varias ubicaciones
 * 3. Se detiene (stop)
 * 4. Vuelve a arrancar
 * 5. Apaga la ignición
 */

const Redis = require('ioredis');

const redis = new Redis({
  host: 'localhost',
  port: 6380,
  db: 0,
});

// Configuración del dispositivo de prueba
const DEVICE_ID = 'TEST-DEVICE-001';
const BASE_LAT = -31.4201; // Córdoba, Argentina
const BASE_LON = -64.1888;

// Función para generar una posición (formato IPositionEvent)
function createPosition(overrides = {}) {
  const now = Date.now();
  return {
    deviceId: DEVICE_ID,
    timestamp: now,
    latitude: BASE_LAT,
    longitude: BASE_LON,
    speed: 0,
    heading: 0,
    altitude: 400,
    ignition: false,
    ...overrides,
  };
}

// Función para publicar una posición
async function publishPosition(position) {
  const message = JSON.stringify(position);
  await redis.publish('position:new', message);
  console.log(`📍 Posición publicada: lat=${position.latitude.toFixed(4)}, lon=${position.longitude.toFixed(4)}, speed=${position.speed}km/h, ignition=${position.ignition}`);
}

// Función de espera
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Escenario de prueba: Viaje completo
async function simulateTrip() {
  console.log('🚗 Iniciando simulación de viaje completo...\n');

  try {
    // 1. Vehículo encendido, parado
    console.log('1️⃣  Fase 1: Vehículo encendido (ignición ON, velocidad 0)');
    await publishPosition(createPosition({
      ignition: true,
      speed: 0,
    }));
    await sleep(2000);

    // 2. Comenzando a moverse
    console.log('\n2️⃣  Fase 2: Vehículo en movimiento');
    for (let i = 1; i <= 5; i++) {
      await publishPosition(createPosition({
        ignition: true,
        speed: 20 + (i * 5), // Acelerando
        latitude: BASE_LAT + (i * 0.0001),
        longitude: BASE_LON + (i * 0.0001),
        heading: 45,
      }));
      await sleep(1500);
    }

    // 3. Detención prolongada (stop)
    console.log('\n3️⃣  Fase 3: Detención prolongada (STOP)');
    const stopLat = BASE_LAT + 0.0006;
    const stopLon = BASE_LON + 0.0006;

    await publishPosition(createPosition({
      ignition: true,
      speed: 0,
      latitude: stopLat,
      longitude: stopLon,
    }));

    console.log('⏸️  Esperando 12 segundos para activar detección de stop...');
    await sleep(12000); // Esperamos más del umbral de 10 segundos

    // Más posiciones parado
    for (let i = 0; i < 3; i++) {
      await publishPosition(createPosition({
        ignition: true,
        speed: 0,
        latitude: stopLat,
        longitude: stopLon,
      }));
      await sleep(2000);
    }

    // 4. Volviendo a moverse
    console.log('\n4️⃣  Fase 4: Reanudando movimiento');
    for (let i = 1; i <= 4; i++) {
      await publishPosition(createPosition({
        ignition: true,
        speed: 25 + (i * 3),
        latitude: stopLat + (i * 0.0001),
        longitude: stopLon + (i * 0.0001),
        heading: 135,
      }));
      await sleep(1500);
    }

    // 5. Apagado final
    console.log('\n5️⃣  Fase 5: Apagando ignición (FIN DEL VIAJE)');
    const finalLat = stopLat + 0.0005;
    const finalLon = stopLon + 0.0005;

    // Frenando
    await publishPosition(createPosition({
      ignition: true,
      speed: 10,
      latitude: finalLat,
      longitude: finalLon,
    }));
    await sleep(1000);

    // Detenido con ignición on
    await publishPosition(createPosition({
      ignition: true,
      speed: 0,
      latitude: finalLat,
      longitude: finalLon,
    }));
    await sleep(1000);

    // Ignición off
    await publishPosition(createPosition({
      ignition: false,
      speed: 0,
      latitude: finalLat,
      longitude: finalLon,
    }));

    console.log('\n✅ Simulación completada!');
    console.log(`\n📊 Resumen:`);
    console.log(`   - Dispositivo: ${DEVICE_ID}`);
    console.log(`   - Posiciones enviadas: ~20`);
    console.log(`   - Trip esperado: 1 (detectado por ignición)`);
    console.log(`   - Stops esperados: 1 (detención prolongada en medio del viaje)`);
    console.log(`\n💡 Verifica los resultados con:`);
    console.log(`   - GET /trackers/${DEVICE_ID}/status`);
    console.log(`   - GET /api/reports/trips?deviceId=${DEVICE_ID}&from=2024-01-01T00:00:00Z&to=2025-12-31T23:59:59Z`);
    console.log(`   - GET /api/reports/stops?deviceId=${DEVICE_ID}&from=2024-01-01T00:00:00Z&to=2025-12-31T23:59:59Z`);

  } catch (error) {
    console.error('❌ Error durante la simulación:', error);
  } finally {
    await sleep(2000);
    redis.disconnect();
    console.log('\n🔌 Desconectado de Redis');
  }
}

// Ejecutar simulación
simulateTrip();
