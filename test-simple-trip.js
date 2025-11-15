/**
 * Script de prueba simple para Tripero
 * Simula un viaje corto publicando posiciones GPS a Redis
 */

const Redis = require('ioredis');

const redis = new Redis({
  host: 'localhost',
  port: 6380,
  db: 0,
});

// Coordenadas de prueba: Viaje de Plaza de Mayo a Obelisco (Buenos Aires)
const positions = [
  // Inicio: Plaza de Mayo (ignición ON)
  { lat: -34.6037, lon: -58.3816, speed: 0, ignition: true, time: 0 },

  // Empezando a moverse
  { lat: -34.6035, lon: -58.3820, speed: 15, ignition: true, time: 5 },
  { lat: -34.6033, lon: -58.3825, speed: 25, ignition: true, time: 10 },
  { lat: -34.6030, lon: -58.3830, speed: 35, ignition: true, time: 15 },

  // Avanzando por Av. de Mayo
  { lat: -34.6025, lon: -58.3840, speed: 40, ignition: true, time: 20 },
  { lat: -34.6020, lon: -58.3850, speed: 45, ignition: true, time: 25 },
  { lat: -34.6015, lon: -58.3860, speed: 50, ignition: true, time: 30 },
  { lat: -34.6010, lon: -58.3870, speed: 50, ignition: true, time: 35 },

  // Llegando al Obelisco
  { lat: -34.6005, lon: -58.3880, speed: 40, ignition: true, time: 40 },
  { lat: -34.6000, lon: -58.3885, speed: 30, ignition: true, time: 45 },
  { lat: -34.5996, lon: -58.3890, speed: 20, ignition: true, time: 50 },
  { lat: -34.5993, lon: -58.3895, speed: 10, ignition: true, time: 55 },

  // Detenido en el Obelisco (ignición OFF después de 60 segundos)
  { lat: -34.5990, lon: -58.3900, speed: 0, ignition: true, time: 60 },
  { lat: -34.5990, lon: -58.3900, speed: 0, ignition: false, time: 65 },
];

const TRACKER_ID = 'TEST-TRACKER-001';

async function publishPositions() {
  console.log('🚀 Iniciando prueba de viaje simple');
  console.log(`📍 Tracker ID: ${TRACKER_ID}`);
  console.log(`📊 Total posiciones: ${positions.length}`);
  console.log('---');

  const startTime = Date.now();

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const timestamp = startTime + (pos.time * 1000);

    const positionEvent = {
      deviceId: TRACKER_ID,
      timestamp,
      latitude: pos.lat,
      longitude: pos.lon,
      speed: pos.speed,
      ignition: pos.ignition,
      heading: 90, // Este
      accuracy: 10,
      satellites: 12,
    };

    try {
      await redis.publish('position:new', JSON.stringify(positionEvent));

      const statusEmoji = pos.ignition ? '🟢' : '🔴';
      console.log(
        `${statusEmoji} Posición ${i + 1}/${positions.length}: ` +
        `Lat=${pos.lat.toFixed(4)}, Lon=${pos.lon.toFixed(4)}, ` +
        `Speed=${pos.speed} km/h, Ignition=${pos.ignition ? 'ON' : 'OFF'}`
      );

      // Esperar 1 segundo entre posiciones (simular tiempo real)
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error('❌ Error publicando posición:', error.message);
    }
  }

  console.log('---');
  console.log('✅ Prueba completada');
  console.log('');
  console.log('💡 Ahora puedes consultar:');
  console.log(`   curl http://localhost:3001/trackers/${TRACKER_ID}/status | jq .`);
  console.log('');

  redis.disconnect();
}

redis.on('ready', () => {
  console.log('✅ Conectado a Redis');
  publishPositions().catch(console.error);
});

redis.on('error', (err) => {
  console.error('❌ Error de Redis:', err.message);
  process.exit(1);
});
