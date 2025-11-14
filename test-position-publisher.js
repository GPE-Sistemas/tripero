/**
 * Script de prueba para publicar posiciones GPS simuladas
 *
 * Uso:
 *   node test-position-publisher.js
 *
 * Requisitos:
 *   - Redis corriendo en localhost:6379
 *   - npm install ioredis
 */

const Redis = require('ioredis');

const redis = new Redis({
  host: 'localhost',
  port: 6380,
  db: 0,
});

// Simular un viaje completo
async function simulateTrip() {
  const deviceId = 'TEST-DEVICE-001';
  const startTime = Date.now();

  console.log('\n🚗 Simulando viaje de prueba...\n');

  // 1. Vehículo detenido, motor apagado
  console.log('1️⃣  Vehículo detenido (ignition OFF)');
  await publishPosition({
    deviceId,
    timestamp: startTime,
    latitude: -34.6037,
    longitude: -58.3816,
    speed: 0,
    ignition: false,
  });
  await sleep(2000);

  // 2. Motor encendido, aún detenido
  console.log('2️⃣  Motor encendido (ignition ON, speed 0) - IDLE');
  await publishPosition({
    deviceId,
    timestamp: startTime + 5000,
    latitude: -34.6037,
    longitude: -58.3816,
    speed: 0,
    ignition: true,
  });
  await sleep(2000);

  // 3. Empezar a moverse - INICIA TRIP
  console.log('3️⃣  Empieza a moverse (speed > 5 km/h) - 🎯 TRIP STARTED');
  await publishPosition({
    deviceId,
    timestamp: startTime + 10000,
    latitude: -34.6040,
    longitude: -58.3820,
    speed: 15,
    ignition: true,
    heading: 45,
    satellites: 12,
  });
  await sleep(2000);

  // 4-10. Varias posiciones en movimiento
  console.log('4️⃣  En movimiento...');
  const positions = [
    { lat: -34.6045, lon: -58.3825, speed: 25 },
    { lat: -34.6050, lon: -58.3830, speed: 35 },
    { lat: -34.6055, lon: -58.3835, speed: 45 },
    { lat: -34.6060, lon: -58.3840, speed: 50 },
    { lat: -34.6065, lon: -58.3845, speed: 55 },
    { lat: -34.6070, lon: -58.3850, speed: 50 },
    { lat: -34.6075, lon: -58.3855, speed: 40 },
  ];

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    await publishPosition({
      deviceId,
      timestamp: startTime + 15000 + (i * 5000),
      latitude: pos.lat,
      longitude: pos.lon,
      speed: pos.speed,
      ignition: true,
      heading: 45,
    });
    await sleep(1000);
  }

  // 11. Reducir velocidad
  console.log('5️⃣  Reduciendo velocidad...');
  await publishPosition({
    deviceId,
    timestamp: startTime + 50000,
    latitude: -34.6080,
    longitude: -58.3860,
    speed: 10,
    ignition: true,
  });
  await sleep(2000);

  // 12. Detenerse con motor encendido - IDLE
  console.log('6️⃣  Detenido con motor encendido (IDLE) - parada dentro del trip');
  await publishPosition({
    deviceId,
    timestamp: startTime + 55000,
    latitude: -34.6085,
    longitude: -58.3865,
    speed: 0,
    ignition: true,
  });
  await sleep(3000);

  // 13. Volver a moverse
  console.log('7️⃣  Vuelve a moverse...');
  await publishPosition({
    deviceId,
    timestamp: startTime + 60000,
    latitude: -34.6090,
    longitude: -58.3870,
    speed: 20,
    ignition: true,
  });
  await sleep(2000);

  // 14. Apagar motor - FINALIZA TRIP
  console.log('8️⃣  Motor apagado - 🏁 TRIP COMPLETED\n');
  await publishPosition({
    deviceId,
    timestamp: startTime + 65000,
    latitude: -34.6095,
    longitude: -58.3875,
    speed: 0,
    ignition: false,
  });

  console.log('✅ Simulación completada!\n');
  console.log('Escucha los eventos en Redis:');
  console.log('  redis-cli SUBSCRIBE trip:started trip:completed\n');

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
      source: 'test-script',
    },
  };

  await redis.publish('position:new', JSON.stringify(event));
  console.log(`   📍 Published: lat=${position.latitude.toFixed(4)}, ` +
              `speed=${position.speed} km/h, ignition=${position.ignition}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Ejecutar simulación
redis.on('connect', () => {
  console.log('✅ Conectado a Redis\n');
  simulateTrip().catch(console.error);
});

redis.on('error', (err) => {
  console.error('❌ Error de Redis:', err.message);
  process.exit(1);
});
