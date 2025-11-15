/**
 * Script para consultar trips de la base de datos
 */
const { Client } = require('pg');

const client = new Client({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  database: 'tripero',
});

async function queryTrips() {
  try {
    await client.connect();
    console.log('✅ Conectado a PostgreSQL\n');

    // Consultar trips
    const tripsResult = await client.query(`
      SELECT
        id,
        start_time,
        end_time,
        id_activo,
        distance,
        max_speed,
        avg_speed,
        duration,
        is_active,
        detection_method
      FROM trips
      ORDER BY start_time DESC
      LIMIT 10;
    `);

    console.log('📊 TRIPS REGISTRADOS:');
    console.log('===================\n');

    if (tripsResult.rows.length === 0) {
      console.log('No hay trips registrados.\n');
    } else {
      tripsResult.rows.forEach((trip, idx) => {
        console.log(`Trip #${idx + 1}:`);
        console.log(`  ID: ${trip.id}`);
        console.log(`  Activo ID: ${trip.id_activo}`);
        console.log(`  Inicio: ${trip.start_time}`);
        console.log(`  Fin: ${trip.end_time || 'En progreso'}`);
        console.log(`  Distancia: ${Math.round(trip.distance)}m (${(trip.distance / 1000).toFixed(2)}km)`);
        console.log(`  Velocidad máx: ${trip.max_speed.toFixed(1)} km/h`);
        console.log(`  Velocidad prom: ${trip.avg_speed.toFixed(1)} km/h`);
        console.log(`  Duración: ${trip.duration}s (${(trip.duration / 60).toFixed(1)}min)`);
        console.log(`  Activo: ${trip.is_active ? 'Sí' : 'No'}`);
        console.log(`  Método: ${trip.detection_method}`);
        console.log('');
      });
    }

    // Consultar tracker_state
    const stateResult = await client.query(`
      SELECT
        tracker_id,
        device_id,
        total_odometer,
        current_state,
        total_trips_count,
        total_driving_time,
        last_seen_at
      FROM tracker_state
      ORDER BY last_seen_at DESC
      LIMIT 10;
    `);

    console.log('📡 TRACKER STATE:');
    console.log('================\n');

    if (stateResult.rows.length === 0) {
      console.log('No hay tracker state registrado.\n');
    } else {
      stateResult.rows.forEach((state, idx) => {
        console.log(`Tracker #${idx + 1}:`);
        console.log(`  Tracker ID: ${state.tracker_id}`);
        console.log(`  Device ID: ${state.device_id}`);
        console.log(`  Odómetro total: ${Math.round(state.total_odometer)}m (${(state.total_odometer / 1000).toFixed(2)}km)`);
        console.log(`  Estado actual: ${state.current_state}`);
        console.log(`  Total trips: ${state.total_trips_count}`);
        console.log(`  Tiempo conducción: ${state.total_driving_time}s (${(state.total_driving_time / 60).toFixed(1)}min)`);
        console.log(`  Última vez visto: ${state.last_seen_at}`);
        console.log('');
      });
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await client.end();
  }
}

queryTrips().catch(console.error);
