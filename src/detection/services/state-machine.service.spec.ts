import { Test, TestingModule } from '@nestjs/testing';
import { StateMachineService } from './state-machine.service';
import { DistanceValidatorService } from './distance-validator.service';
import { MotionState, IDeviceMotionState } from '../models';
import { IPositionEvent } from '../../interfaces';

/**
 * Regresión del bug de stops perdidos en transiciones IDLE↔STOPPED.
 * Ver TRIPERO_AUDIT_REPORT.md — caso 7079 (2026-04-17).
 */
describe('StateMachineService — stop lifecycle in IDLE↔STOPPED transitions', () => {
  let service: StateMachineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StateMachineService, DistanceValidatorService],
    }).compile();

    service = module.get<StateMachineService>(StateMachineService);
  });

  /** Construye un IPositionEvent. */
  const pos = (overrides: Partial<IPositionEvent>): IPositionEvent => ({
    deviceId: '7079',
    timestamp: 0,
    latitude: -34.75,
    longitude: -58.28,
    speed: 0,
    ignition: false,
    ...overrides,
  });

  /** State inicial en IDLE con stop abierto desde `stopStartTime`. */
  const idleStateWithStop = (
    stopStartTime: number,
    lastTimestamp: number,
  ): IDeviceMotionState => ({
    deviceId: '7079',
    state: MotionState.IDLE,
    stateStartTime: stopStartTime,
    lastTimestamp,
    lastLat: -34.75,
    lastLon: -58.28,
    lastSpeed: 0,
    lastIgnition: true,
    lastUpdate: lastTimestamp,
    version: 1,
    currentStopId: 'stop_7079_old_idle',
    stopStartTime,
    stopStartLat: -34.75,
    stopStartLon: -58.28,
    stopReason: 'no_movement',
    recentPositions: [],
  });

  /** State inicial en STOPPED (ignition OFF) con stop abierto. */
  const stoppedStateWithStop = (
    stopStartTime: number,
    lastTimestamp: number,
  ): IDeviceMotionState => ({
    deviceId: '7079',
    state: MotionState.STOPPED,
    stateStartTime: stopStartTime,
    lastTimestamp,
    lastLat: -34.75,
    lastLon: -58.28,
    lastSpeed: 0,
    lastIgnition: false,
    lastUpdate: lastTimestamp,
    version: 1,
    currentStopId: 'stop_7079_old_stopped',
    stopStartTime,
    stopStartLat: -34.75,
    stopStartLon: -58.28,
    stopReason: 'ignition_off',
    recentPositions: [],
  });

  describe('IDLE → STOPPED (ignición se apaga durante parada)', () => {
    it('marks both endStop and startStop', () => {
      // t=0 el vehículo está IDLE con motor encendido
      // t=120s el conductor apaga el motor → ignición OFF
      const prior = idleStateWithStop(0, 60_000);
      const result = service.processPosition(
        pos({ timestamp: 120_000, ignition: false, speed: 0 }),
        prior,
      );

      expect(result.previousState).toBe(MotionState.IDLE);
      expect(result.newState).toBe(MotionState.STOPPED);
      expect(result.actions.endStop).toBe(true);
      expect(result.actions.startStop).toBe(true);
    });

    it('captures previousStop with the old stop data', () => {
      const prior = idleStateWithStop(0, 60_000);
      const result = service.processPosition(
        pos({ timestamp: 120_000, ignition: false, speed: 0 }),
        prior,
      );

      // El snapshot debe apuntar al stop IDLE viejo, no al nuevo de STOPPED.
      expect(result.previousStop).toBeDefined();
      expect(result.previousStop!.stopId).toBe('stop_7079_old_idle');
      expect(result.previousStop!.startTime).toBe(0);
      expect(result.previousStop!.reason).toBe('no_movement');
    });

    it('rotates updatedState.currentStopId to a new value', () => {
      const prior = idleStateWithStop(0, 60_000);
      const result = service.processPosition(
        pos({ timestamp: 120_000, ignition: false, speed: 0 }),
        prior,
      );

      // Después de la transición, el state tiene el stop NUEVO.
      expect(result.updatedState.currentStopId).toBeDefined();
      expect(result.updatedState.currentStopId).not.toBe('stop_7079_old_idle');
      expect(result.updatedState.stopStartTime).toBe(120_000);
      expect(result.updatedState.stopReason).toBe('ignition_off');
    });

    it('preserves enough info to compute real duration of the old stop', () => {
      // Simula parada real de 2 horas antes de que se apague la ignición.
      const prior = idleStateWithStop(0, 7_200_000);
      const result = service.processPosition(
        pos({ timestamp: 7_200_000, ignition: false, speed: 0 }),
        prior,
      );

      // duration del stop viejo = position.timestamp - previousStop.startTime
      const duration =
        (7_200_000 - result.previousStop!.startTime) / 1000;
      expect(duration).toBeCloseTo(7200, 0); // 2 horas
    });
  });

  describe('STOPPED → IDLE (se enciende el motor después de parada larga)', () => {
    it('marks both endStop and startStop', () => {
      // Gap pequeño entre lastTimestamp y position.timestamp para evitar handleLargeGap.
      const prior = stoppedStateWithStop(0, 7_199_000);
      const result = service.processPosition(
        pos({ timestamp: 7_200_000, ignition: true, speed: 0 }),
        prior,
      );

      expect(result.previousState).toBe(MotionState.STOPPED);
      expect(result.newState).toBe(MotionState.IDLE);
      expect(result.actions.endStop).toBe(true);
      expect(result.actions.startStop).toBe(true);
    });

    it('captures previousStop with the ignition_off stop data', () => {
      const prior = stoppedStateWithStop(0, 7_199_000);
      const result = service.processPosition(
        pos({ timestamp: 7_200_000, ignition: true, speed: 0 }),
        prior,
      );

      expect(result.previousStop).toBeDefined();
      expect(result.previousStop!.stopId).toBe('stop_7079_old_stopped');
      expect(result.previousStop!.startTime).toBe(0);
      expect(result.previousStop!.reason).toBe('ignition_off');
    });
  });

  describe('IDLE → MOVING (sólo endStop, sin startStop)', () => {
    it('does not populate previousStop when only endStop fires', () => {
      // Stop IDLE de 6 minutos → vehículo acelera.
      // speedAvg30s debe ser alto para que determineState transicione a MOVING
      // (la lógica exige velocidad instantánea Y promedio sobre minMovingSpeed).
      const prior = idleStateWithStop(0, 360_000);
      prior.speedAvg30s = 30;
      const result = service.processPosition(
        pos({ timestamp: 360_000, ignition: true, speed: 30 }),
        prior,
      );

      expect(result.previousState).toBe(MotionState.IDLE);
      expect(result.newState).toBe(MotionState.MOVING);
      expect(result.actions.endStop).toBe(true);
      expect(result.actions.startStop).toBe(false);
      expect(result.previousStop).toBeUndefined();
      // updatedState conserva los datos del stop viejo (processor los usará).
      expect(result.updatedState.currentStopId).toBe('stop_7079_old_idle');
      expect(result.updatedState.stopStartTime).toBe(0);
    });
  });

  describe('MOVING → STOPPED (sólo startStop, trip sigue abierto)', () => {
    it('does not populate previousStop when only startStop fires', () => {
      const prior: IDeviceMotionState = {
        deviceId: '7079',
        state: MotionState.MOVING,
        stateStartTime: 0,
        lastTimestamp: 60_000,
        lastLat: -34.75,
        lastLon: -58.28,
        lastSpeed: 30,
        lastIgnition: true,
        lastUpdate: 60_000,
        version: 1,
        currentTripId: 'trip_7079_abc',
        tripStartTime: 0,
        tripStartLat: -34.75,
        tripStartLon: -58.28,
        recentPositions: [],
      };

      const result = service.processPosition(
        pos({ timestamp: 120_000, ignition: false, speed: 0 }),
        prior,
      );

      expect(result.newState).toBe(MotionState.STOPPED);
      expect(result.actions.startStop).toBe(true);
      expect(result.actions.endStop).toBe(false);
      expect(result.previousStop).toBeUndefined();
    });
  });

  describe('regresión caso 7079 — parada larga con oscilación de ignición', () => {
    /**
     * Secuencia real del 2026-04-17:
     *   - IDLE con motor encendido durante 1 minuto
     *   - se apaga ignición (IDLE → STOPPED)
     *   - quieto 2h 8min con motor apagado
     *   - se enciende ignición (STOPPED → IDLE)
     *   - se empieza a mover (IDLE → MOVING)
     *
     * Resultado esperado tras el fix: NINGÚN snapshot se pierde. Los tres eventos
     * `endStop` ven siempre un stop viejo con duración realista.
     */
    it('chains transitions without losing any old stop data', () => {
      // (1) t=0..60s — IDLE con motor encendido.
      let state = idleStateWithStop(0, 59_000);

      // (2) t=60s — IDLE → STOPPED (ignición OFF).
      const r1 = service.processPosition(
        pos({ timestamp: 60_000, ignition: false, speed: 0 }),
        state,
      );
      expect(r1.previousStop?.stopId).toBe('stop_7079_old_idle');
      expect(r1.actions.endStop && r1.actions.startStop).toBe(true);
      state = { ...r1.updatedState };
      const stopStoppedId = state.currentStopId!;

      // (3) t=60s..7260s — quieto 2h con motor apagado. Para evitar handleLargeGap,
      // simulamos que el tracker siguió reportando cada cierto tiempo manteniendo
      // lastTimestamp actualizado. Forzamos lastTimestamp justo antes del próximo evento.
      state.lastTimestamp = 7_259_000;

      // (4) t=7260s — STOPPED → IDLE (ignición ON, speed=0).
      const r2 = service.processPosition(
        pos({ timestamp: 7_260_000, ignition: true, speed: 0 }),
        state,
      );
      expect(r2.previousStop?.stopId).toBe(stopStoppedId);
      // startTime del stop STOPPED = 60_000 (cuando se creó en r1).
      const stoppedDuration =
        (7_260_000 - r2.previousStop!.startTime) / 1000;
      expect(stoppedDuration).toBeCloseTo(7200, 0); // 2h
      expect(r2.actions.endStop && r2.actions.startStop).toBe(true);
      state = { ...r2.updatedState };
      const stopIdleId = state.currentStopId!;

      // (5) t=7620s — IDLE → MOVING (speed > 5 km/h, promedio también).
      state.lastTimestamp = 7_619_000;
      state.speedAvg30s = 30;
      const r3 = service.processPosition(
        pos({ timestamp: 7_620_000, ignition: true, speed: 30 }),
        state,
      );
      // Sólo endStop: previousStop no se usa, pero updatedState tiene el IDLE.
      expect(r3.actions.endStop).toBe(true);
      expect(r3.actions.startStop).toBe(false);
      expect(r3.previousStop).toBeUndefined();
      expect(r3.updatedState.currentStopId).toBe(stopIdleId);
    });
  });
});
