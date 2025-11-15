/**
 * Script de prueba para detección de stops en Tripero
 * Simula un viaje con múltiples paradas (stops)
 */

const Redis = require('ioredis');

const redis = new Redis({
  host: 'localhost',
  port: 6380,
  db: 0,
});

/**
 * Escenario de prueba: Viaje con 3 tipos de stops
 * 1. Stop IDLE (semáforo/tráfico): ignición ON, sin movimiento
 * 2. Stop IGNITION_OFF: motor apagado
 * 3. Múltiples stops durante el mismo trip
 */
const positions = [
  // === INICIO: Plaza de Mayo ===
  { lat: -34.6037, lon: -58.3816, speed: 0, ignition: true, time: 0, comment: 'Inicio - motor encendido' },

  // === MOVING: Empezando a moverse ===
  { lat: -34.6035, lon: -58.3820, speed: 15, ignition: true, time: 5, comment: 'Acelerando' },
  { lat: -34.6033, lon: -58.3825, speed: 25, ignition: true, time: 10, comment: 'En movimiento' },
  { lat: -34.6030, lon: -58.3830, speed: 35, ignition: true, time: 15, comment: 'Velocidad constante' },

  // === STOP 1: IDLE (semáforo) - ignición ON, sin movimiento ===
  { lat: -34.6025, lon: -58.3840, speed: 30, ignition: true, time: 20, comment: 'Frenando' },
  { lat: -34.6025, lon: -58.3840, speed: 10, ignition: true, time: 25, comment: 'Casi detenido' },
  { lat: -34.6025, lon: -58.3840, speed: 0, ignition: true, time: 30, comment: 'STOP IDLE - semáforo' },
  { lat: -34.6025, lon: -58.3840, speed: 0, ignition: true, time: 35, comment: 'Esperando semáforo' },
  { lat: -34.6025, lon: -58.3840, speed: 0, ignition: true, time: 40, comment: 'Esperando semáforo' },
  { lat: -34.6025, lon: -58.3840, speed: 0, ignition: true, time: 45, comment: 'Esperando semáforo' },

  // === MOVING: Reanudando marcha ===
  { lat: -34.6025, lon: -58.3840, speed: 10, ignition: true, time: 50, comment: 'Arrancando del semáforo' },
  { lat: -34.6020, lon: -58.3850, speed: 30, ignition: true, time: 55, comment: 'Acelerando' },
  { lat: -34.6015, lon: -58.3860, speed: 45, ignition: true, time: 60, comment: 'En movimiento' },
  { lat: -34.6010, lon: -58.3870, speed: 50, ignition: true, time: 65, comment: 'Velocidad crucero' },

  // === STOP 2: IDLE (tráfico) ===
  { lat: -34.6005, lon: -58.3880, speed: 40, ignition: true, time: 70, comment: 'Frenando por tráfico' },
  { lat: -34.6005, lon: -58.3880, speed: 15, ignition: true, time: 75, comment: 'Casi detenido' },
  { lat: -34.6005, lon: -58.3880, speed: 0, ignition: true, time: 80, comment: 'STOP IDLE - tráfico' },
  { lat: -34.6005, lon: -58.3880, speed: 0, ignition: true, time: 85, comment: 'Detenido en tráfico' },
  { lat: -34.6005, lon: -58.3880, speed: 0, ignition: true, time: 90, comment: 'Detenido en tráfico' },

  // === MOVING: Continuando ===
  { lat: -34.6005, lon: -58.3880, speed: 8, ignition: true, time: 95, comment: 'Reanudando' },
  { lat: -34.6000, lon: -58.3885, speed: 25, ignition: true, time: 100, comment: 'Acelerando' },
  { lat: -34.5996, lon: -58.3890, speed: 40, ignition: true, time: 105, comment: 'En movimiento' },

  // === STOP 3: IGNITION_OFF (estacionamiento) ===
  { lat: -34.5993, lon: -58.3895, speed: 35, ignition: true, time: 110, comment: 'Frenando para estacionar' },
  { lat: -34.5990, lon: -58.3900, speed: 15, ignition: true, time: 115, comment: 'Llegando al destino' },
  { lat: -34.5990, lon: -58.3900, speed: 5, ignition: true, time: 120, comment: 'Casi detenido' },
  { lat: -34.5990, lon: -58.3900, speed: 0, ignition: true, time: 125, comment: 'Detenido' },
  { lat: -34.5990, lon: -58.3900, speed: 0, ignition: false, time: 130, comment: 'STOP IGNITION_OFF - fin del trip' },
  { lat: -34.5990, lon: -58.3900, speed: 0, ignition: false, time: 135, comment: 'Vehículo apagado' },
  { lat: -34.5990, lon: -58.3900, speed: 0, ignition: false, time: 140, comment: 'Vehículo apagado' },
];

const TRACKER_ID = 'TEST-STOPS-001';

async function publishPositions() {
  console.log('🛑 Iniciando prueba de DETECCIÓN DE STOPS');
  console.log(`📍 Tracker ID: ${TRACKER_ID}`);
  console.log(`📊 Total posiciones: ${positions.length}`);
  console.log('');
  console.log('📝 Escenarios de prueba:');
  console.log('  1️⃣  Stop IDLE (semáforo): ignición ON, velocidad 0');
  console.log('  2️⃣  Stop IDLE (tráfico): ignición ON, velocidad 0');
  console.log('  3️⃣  Stop IGNITION_OFF: motor apagado');
  console.log('---');

  const startTime = Date.now();
  let stopCount = 0;

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

      // Determinar emoji de estado
      let statusEmoji = '🟢';
      if (!pos.ignition) {
        statusEmoji = '🔴';
      } else if (pos.speed === 0) {
        statusEmoji = '🟡';
      } else if (pos.speed < 10) {
        statusEmoji = '🟠';
      }

      // Detectar si es un stop nuevo
      if (pos.comment.includes('STOP')) {
        stopCount++;
        console.log('');
        console.log(`🛑 === STOP ${stopCount} DETECTADO ===`);
      }

      console.log(
        `${statusEmoji} Posición ${i + 1}/${positions.length} [${pos.time}s]: ` +
        `Speed=${pos.speed.toString().padStart(2)} km/h, ` +
        `Ign=${pos.ignition ? 'ON ' : 'OFF'} | ` +
        `${pos.comment}`
      );

      // Esperar 1 segundo entre posiciones (simular tiempo real)
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error('❌ Error publicando posición:', error.message);
    }
  }

  console.log('');
  console.log('---');
  console.log('✅ Prueba completada');
  console.log('');
  console.log('📊 Resultados esperados:');
  console.log('  • 1 Trip completado');
  console.log('  • 3 Stops detectados:');
  console.log('    - 2 stops IDLE (no_movement)');
  console.log('    - 1 stop IGNITION_OFF');
  console.log('  • Trip con stop_count = 2 (solo stops DENTRO del trip)');
  console.log('');
  console.log('💡 Consultas disponibles:');
  console.log(`   curl http://localhost:3001/trackers/${TRACKER_ID}/status | jq .`);
  console.log('');
  console.log('🔍 Verificar en PostgreSQL:');
  console.log(`   SELECT * FROM stops WHERE id_activo = '${TRACKER_ID}' ORDER BY start_time;`);
  console.log(`   SELECT * FROM trips WHERE id_activo = '${TRACKER_ID}' ORDER BY start_time;`);
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
