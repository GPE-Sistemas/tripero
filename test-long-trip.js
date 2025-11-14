/**
 * Script de prueba para publicar un viaje largo que cumpla con los umbrales
 *
 * Umbrales mínimos:
 * - Duración: 60 segundos
 * - Distancia: 100 metros
 *
 * Este script genera un viaje de ~90 segundos con ~2km de distancia
 *
 * Uso:
 *   node test-long-trip.js
 */

const Redis = require('ioredis');

const redis = new Redis({
  host: 'localhost',
  port: 6380,
  db: 0,
});

// Simular un viaje largo
async function simulateLongTrip() {
  const deviceId = 'TEST-VEHICLE-001';
  const startTime = Date.now();

  console.log('\n🚗 Simulando viaje LARGO (90+ segundos, 2+ km)...\n');

  // 1. Vehículo detenido, motor apagado
  console.log('1️⃣  Vehículo detenido (ignition OFF)');
  await publishPosition({
    deviceId,
    timestamp: Date.now(),
    latitude: -34.6037,
    longitude: -58.3816,
    speed: 0,
    ignition: false,
  });
  await sleep(5000);

  // 2. Motor encendido, aún detenido
  console.log('2️⃣  Motor encendido (ignition ON, speed 0) - IDLE');
  await publishPosition({
    deviceId,
    timestamp: Date.now(),
    latitude: -34.6037,
    longitude: -58.3816,
    speed: 0,
    ignition: true,
  });
  await sleep(5000);

  // 3. Empezar a moverse - INICIA TRIP
  console.log('3️⃣  Empieza a moverse (speed > 5 km/h) - 🎯 TRIP STARTED');
  await publishPosition({
    deviceId,
    timestamp: Date.now(),
    latitude: -34.6040,
    longitude: -58.3820,
    speed: 15,
    ignition: true,
    heading: 45,
    satellites: 12,
  });
  await sleep(5000);

  // 4-20. Muchas posiciones en movimiento durante ~70 segundos
  console.log('4️⃣  En movimiento continuo por 70+ segundos...');

  const movingPositions = [
    // Primeros 20 segundos - acelerando
    { lat: -34.6045, lon: -58.3825, speed: 25, sleepMs: 5000 },
    { lat: -34.6050, lon: -58.3830, speed: 35, sleepMs: 5000 },
    { lat: -34.6055, lon: -58.3835, speed: 45, sleepMs: 5000 },
    { lat: -34.6060, lon: -58.3840, speed: 50, sleepMs: 5000 },

    // 20-40 segundos - velocidad crucero
    { lat: -34.6065, lon: -58.3845, speed: 55, sleepMs: 5000 },
    { lat: -34.6070, lon: -58.3850, speed: 55, sleepMs: 5000 },
    { lat: -34.6075, lon: -58.3855, speed: 50, sleepMs: 5000 },
    { lat: -34.6080, lon: -58.3860, speed: 50, sleepMs: 5000 },
    { lat: -34.6085, lon: -58.3865, speed: 50, sleepMs: 5000 },
    { lat: -34.6090, lon: -58.3870, speed: 45, sleepMs: 5000 },

    // 40-60 segundos - continuando
    { lat: -34.6095, lon: -58.3875, speed: 45, sleepMs: 5000 },
    { lat: -34.6100, lon: -58.3880, speed: 40, sleepMs: 5000 },
    { lat: -34.6105, lon: -58.3885, speed: 40, sleepMs: 5000 },
    { lat: -34.6110, lon: -58.3890, speed: 35, sleepMs: 5000 },

    // 60-80 segundos - desacelerando
    { lat: -34.6115, lon: -58.3895, speed: 30, sleepMs: 5000 },
    { lat: -34.6120, lon: -58.3900, speed: 25, sleepMs: 5000 },
    { lat: -34.6125, lon: -58.3905, speed: 20, sleepMs: 5000 },
    { lat: -34.6130, lon: -58.3910, speed: 15, sleepMs: 5000 },
  ];

  for (let i = 0; i < movingPositions.length; i++) {
    const pos = movingPositions[i];
    await publishPosition({
      deviceId,
      timestamp: Date.now(), // Usar timestamp actual en vez de futuro
      latitude: pos.lat,
      longitude: pos.lon,
      speed: pos.speed,
      ignition: true,
      heading: 45,
    });
    await sleep(pos.sleepMs); // Esperar el tiempo real entre posiciones

    if ((i + 1) % 5 === 0) {
      console.log(`   ✓ ${i + 1}/${movingPositions.length} posiciones publicadas`);
    }
  }

  // Final. Reducir a velocidad muy baja
  console.log('5️⃣  Reduciendo velocidad final...');
  await publishPosition({
    deviceId,
    timestamp: Date.now(),
    latitude: -34.6135,
    longitude: -58.3915,
    speed: 5,
    ignition: true,
  });
  await sleep(5000);

  // Apagar motor - FINALIZA TRIP
  console.log('6️⃣  Motor apagado - 🏁 TRIP COMPLETED\n');
  await publishPosition({
    deviceId,
    timestamp: Date.now(),
    latitude: -34.6140,
    longitude: -58.3920,
    speed: 0,
    ignition: false,
  });

  console.log('✅ Simulación completada!\n');
  console.log('📊 Métricas del viaje simulado:');
  console.log('   - Duración: ~100 segundos (> 60s requeridos)');
  console.log('   - Distancia: ~2.3 km (> 100m requeridos)');
  console.log('   - Velocidad promedio: ~40 km/h');
  console.log('   - Velocidad máxima: 55 km/h\n');
  console.log('🔍 Verifica los eventos publicados:');
  console.log('   docker exec tripero-redis redis-cli SUBSCRIBE trip:started trip:completed\n');

  await sleep(1000);
  process.exit(0);
}

async function publishPosition(position) {
  const event = {
    deviceId: position.deviceId,
    timestamp: position.timestamp,
    latitude: position.latitude,
    longitude: position.longitude,
    speed: position.speed,
    ignition: position.ignition,
    heading: position.heading,
    satellites: position.satellites,
    metadata: {
      source: 'test-long-trip',
    },
  };

  await redis.publish('position:new', JSON.stringify(event));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Ejecutar simulación
redis.on('connect', () => {
  console.log('✅ Conectado a Redis\n');
  simulateLongTrip().catch(console.error);
});

redis.on('error', (err) => {
  console.error('❌ Error de Redis:', err.message);
  process.exit(1);
});
