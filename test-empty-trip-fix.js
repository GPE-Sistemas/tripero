/**
 * Test para verificar el fix de trips vacíos
 * 
 * Casos de prueba:
 * 1. Trip muy corto (< 100m, < 3 posiciones) → NO debe crearse en BD
 * 2. Trip que alcanza 100m → SÍ debe crearse en BD
 * 3. Trip que alcanza 3 posiciones → SÍ debe crearse en BD
 */

const Redis = require('ioredis');

const redis = new Redis({
  host: 'localhost',
  port: 6380,
  db: 0,
});

// CASO 1: Trip MUY CORTO - No debe crearse en BD
const shortTripPositions = [
  // Inicio: movimiento detectado
  { lat: -34.6037, lon: -58.3816, speed: 0, ignition: true, time: 0 },
  { lat: -34.6037, lon: -58.3817, speed: 20, ignition: true, time: 5 }, // ~11m
  // Inmediatamente se detiene
  { lat: -34.6037, lon: -58.3818, speed: 0, ignition: false, time: 10 }, // ~11m más = 22m total
];

// CASO 2: Trip que alcanza 100m - Debe crearse en BD
const mediumTripPositions = [
  { lat: -34.6037, lon: -58.3816, speed: 0, ignition: true, time: 0 },
  { lat: -34.6035, lon: -58.3820, speed: 15, ignition: true, time: 5 },   // ~40m
  { lat: -34.6033, lon: -58.3825, speed: 25, ignition: true, time: 10 },  // ~50m
  { lat: -34.6030, lon: -58.3830, speed: 35, ignition: true, time: 15 },  // ~35m = 125m total
  { lat: -34.6030, lon: -58.3830, speed: 0, ignition: false, time: 20 },
];

// CASO 3: Trip con 3+ posiciones pero poca distancia - Debe crearse en BD
const multiPositionTripPositions = [
  { lat: -34.6037, lon: -58.3816, speed: 0, ignition: true, time: 0 },
  { lat: -34.6037, lon: -58.3817, speed: 10, ignition: true, time: 5 },   // ~11m
  { lat: -34.6037, lon: -58.3818, speed: 10, ignition: true, time: 10 },  // ~11m
  { lat: -34.6037, lon: -58.3819, speed: 10, ignition: true, time: 15 },  // ~11m = 33m, 4 posiciones
  { lat: -34.6037, lon: -58.3819, speed: 0, ignition: false, time: 20 },
];

async function runTest(testName, trackerId, positions) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🧪 ${testName}`);
  console.log(`📍 Tracker ID: ${trackerId}`);
  console.log(`📊 Total posiciones: ${positions.length}`);
  console.log('='.repeat(60));

  const startTime = Date.now();

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const timestamp = startTime + (pos.time * 1000);

    const positionEvent = {
      deviceId: trackerId,
      timestamp,
      latitude: pos.lat,
      longitude: pos.lon,
      speed: pos.speed,
      ignition: pos.ignition,
      heading: 90,
      accuracy: 10,
      satellites: 12,
    };

    await redis.publish('position:new', JSON.stringify(positionEvent));

    const statusEmoji = pos.ignition ? '🟢' : '🔴';
    console.log(
      `${statusEmoji} Posición ${i + 1}/${positions.length}: ` +
      `Speed=${pos.speed} km/h, Ignition=${pos.ignition ? 'ON' : 'OFF'}`
    );

    // Esperar 2 segundos entre posiciones
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('✅ Test completado - esperando procesamiento...');
  // Esperar 5 segundos adicionales para que se procese todo
  await new Promise(resolve => setTimeout(resolve, 5000));
}

async function runAllTests() {
  console.log('🚀 Iniciando tests de validación de trips vacíos');
  console.log('');

  try {
    // Test 1: Trip corto (NO debe crearse)
    await runTest(
      'CASO 1: Trip MUY CORTO (~22m) - NO debe aparecer en BD',
      'TEST-SHORT-TRIP-001',
      shortTripPositions
    );

    // Test 2: Trip medio (SÍ debe crearse)
    await runTest(
      'CASO 2: Trip >= 100m (~125m) - SÍ debe aparecer en BD',
      'TEST-MEDIUM-TRIP-002',
      mediumTripPositions
    );

    // Test 3: Trip con muchas posiciones (SÍ debe crearse)
    await runTest(
      'CASO 3: Trip con 4 posiciones (~33m) - SÍ debe aparecer en BD',
      'TEST-MULTI-POS-003',
      multiPositionTripPositions
    );

    console.log('\n' + '='.repeat(60));
    console.log('✅ TODOS LOS TESTS COMPLETADOS');
    console.log('='.repeat(60));
    console.log('\n💡 Verifica en la BD:');
    console.log('   - TEST-SHORT-TRIP-001: NO debe tener trips');
    console.log('   - TEST-MEDIUM-TRIP-002: SÍ debe tener 1 trip');
    console.log('   - TEST-MULTI-POS-003: SÍ debe tener 1 trip');
    console.log('');
    console.log('🔍 Consulta SQL:');
    console.log("   SELECT id_activo, distance, start_time FROM trips WHERE id_activo LIKE 'TEST-%' ORDER BY start_time DESC;");
    console.log('');

  } catch (error) {
    console.error('❌ Error ejecutando tests:', error);
  } finally {
    redis.disconnect();
  }
}

redis.on('ready', () => {
  console.log('✅ Conectado a Redis');
  runAllTests();
});

redis.on('error', (err) => {
  console.error('❌ Error de Redis:', err.message);
  process.exit(1);
});
