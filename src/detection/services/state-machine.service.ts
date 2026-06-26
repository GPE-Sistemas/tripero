import { Injectable, Logger } from '@nestjs/common';
import {
  MotionState,
  DetectionReason,
  IDeviceMotionState,
  IDetectionThresholds,
  DEFAULT_THRESHOLDS,
} from '../models';
import { IPositionEvent } from '../../interfaces';
import { DistanceValidatorService } from './distance-validator.service';
import { IGNITION_EXPIRY_DAYS } from '../../env';

export interface IIgnitionContext {
  hasIgnition: boolean;
  lastIgnitionSeenAt?: Date;
}

/**
 * Resultado de procesar una posición
 */
export interface IStateTransitionResult {
  previousState: MotionState;
  newState: MotionState;
  transitionOccurred: boolean;
  reason: DetectionReason;

  // Acciones a ejecutar
  actions: {
    startTrip?: boolean;
    endTrip?: boolean;
    discardTrip?: boolean; // true = limpiar estado sin publicar evento (trip muy corto)
    startStop?: boolean;
    endStop?: boolean;
    updateTrip?: boolean;
  };

  // Estado actualizado
  updatedState: IDeviceMotionState;

  // Datos del trip anterior (para cerrar correctamente antes de crear nuevo)
  previousTrip?: {
    tripId: string;
    startTime: number;
    startLat: number;
    startLon: number;
    distance: number;
    maxSpeed: number;
    stopsCount: number;
    confirmed?: boolean; // true si el trip fue publicado a BD
  };

  // Datos del stop anterior (para cerrar correctamente cuando la misma transición
  // marca endStop y startStop — p. ej. IDLE↔STOPPED por oscilación de ignición).
  // Sin este snapshot, el startStop sobrescribe currentStopId/stopStartTime antes
  // de que position-processor publique stop:completed del stop viejo.
  previousStop?: {
    stopId: string;
    startTime: number;
    startLat: number;
    startLon: number;
    reason?: 'ignition_off' | 'no_movement' | 'gap' | 'parking';
    metadata?: Record<string, any>;
  };

  // Información de overnight gap (para tracking de problemas de energía)
  overnightGap?: {
    detected: boolean;
    durationSeconds: number;
  };

  // Cierre de trip "estilo Traccar": cuando el trip se cierra por una parada, el trip
  // termina en el INICIO de la parada (no al reanudar). El tiempo estacionado pertenece
  // al stop, no al trip. position-processor usa esto para el end_time/end_location del trip.
  tripClosure?: {
    endTime: number;
    endLat: number;
    endLon: number;
  };

  // Parada 'gap' YA cerrada: el vehículo reaparece CERCA tras un silencio largo pero
  // ya EN MOVIMIENTO. El silencio fue una parada (start = inicio del silencio,
  // end = reanudación) y el trip nuevo arranca en la reanudación. position-processor
  // publica stop:started + stop:completed de una sola vez para esta parada.
  closedGapStop?: {
    startTime: number;
    startLat: number;
    startLon: number;
    endTime: number;
    endLat: number;
    endLon: number;
  };
}

@Injectable()
export class StateMachineService {
  private readonly logger = new Logger(StateMachineService.name);
  private readonly thresholds: IDetectionThresholds = DEFAULT_THRESHOLDS;

  constructor(private readonly distanceValidator: DistanceValidatorService) {}

  /**
   * Procesa una nueva posición y determina el nuevo estado
   */
  processPosition(
    position: IPositionEvent,
    currentState: IDeviceMotionState | null,
    ignitionContext?: IIgnitionContext,
  ): IStateTransitionResult {
    // Si no hay estado previo, crear uno inicial
    if (!currentState) {
      return this.handleFirstPosition(position, ignitionContext);
    }

    // Validar gap temporal
    const gap = position.timestamp - currentState.lastTimestamp;
    if (gap > this.thresholds.maxGapDuration * 1000) {
      this.logger.warn(
        `Large time gap detected for device ${position.deviceId}: ${gap}ms`,
      );
      return this.handleLargeGap(position, currentState, ignitionContext);
    }

    // Determinar nuevo estado basado en ignición y velocidad
    const newState = this.determineState(
      position,
      currentState,
      ignitionContext,
    );
    const previousState = currentState.state;
    const transitionOccurred = newState !== previousState;

    // Actualizar estado
    const updatedState = this.updateState(position, currentState, newState);

    // Determinar acciones
    const actions = this.determineActions(
      previousState,
      newState,
      updatedState,
    );

    return this.applyTransition(
      position,
      previousState,
      newState,
      updatedState,
      actions,
    );
  }

  /**
   * Aplica las acciones determinadas a `updatedState`: snapshots de trip/stop anterior
   * (para cierres simultáneos), inicialización de trip/stop nuevos, y arma el resultado.
   *
   * Compartido entre el flujo normal y `handleLargeGap` para que un gap NO use una lógica
   * distinta (evita fragmentar stops de vehículos estacionados que reportan espaciado).
   */
  private applyTransition(
    position: IPositionEvent,
    previousState: MotionState,
    newState: MotionState,
    updatedState: IDeviceMotionState,
    actions: IStateTransitionResult['actions'],
    overnightGap?: IStateTransitionResult['overnightGap'],
    gapOverride?: {
      // El trip cerrado por gap termina al cortarse el reporte (no en la reanudación).
      tripEnd?: { endTime: number; endLat: number; endLon: number };
      // El stop de "gap" (no-data) arranca backdateado al inicio del silencio.
      stopStart?: { time: number; lat: number; lon: number; reason: 'gap' };
      // Parada 'gap' ya cerrada (reanuda en movimiento): silencio completo.
      closedGapStop?: {
        startTime: number;
        startLat: number;
        startLon: number;
        endTime: number;
        endLat: number;
        endLon: number;
      };
    },
  ): IStateTransitionResult {
    // Snapshot del trip anterior ANTES de inicializar el nuevo (cierre+inicio simultáneos)
    let previousTrip: IStateTransitionResult['previousTrip'] = undefined;
    if (
      (actions.endTrip || actions.discardTrip) &&
      actions.startTrip &&
      updatedState.currentTripId
    ) {
      previousTrip = {
        tripId: updatedState.currentTripId,
        startTime: updatedState.tripStartTime || 0,
        startLat: updatedState.tripStartLat || 0,
        startLon: updatedState.tripStartLon || 0,
        distance: updatedState.tripDistance || 0,
        maxSpeed: updatedState.tripMaxSpeed || 0,
        stopsCount: updatedState.tripStopsCount || 0,
        confirmed: updatedState.tripConfirmed || false,
      };
    }

    // Cierre estilo Traccar: si el trip se cierra y hay una parada en curso, el trip termina
    // en el INICIO de la parada (no "ahora"). Se calcula ANTES de que startStop sobrescriba
    // stopStartTime. Si el cierre no es por una parada (p. ej. gap nocturno en movimiento sin
    // stop), queda undefined y position-processor usa lastTimestamp.
    let tripClosure: IStateTransitionResult['tripClosure'] = undefined;
    if (gapOverride?.tripEnd && (actions.endTrip || actions.discardTrip)) {
      // Gap nocturno: el trip termina al cortarse el reporte (última posición conocida).
      tripClosure = gapOverride.tripEnd;
    } else if (
      (actions.endTrip || actions.discardTrip) &&
      updatedState.currentStopId &&
      updatedState.stopStartTime !== undefined
    ) {
      tripClosure = {
        endTime: updatedState.stopStartTime,
        endLat: updatedState.stopStartLat ?? updatedState.lastLat,
        endLon: updatedState.stopStartLon ?? updatedState.lastLon,
      };
    }

    // Inicializar trip si es necesario
    if (actions.startTrip) {
      updatedState.currentTripId = this.generateTripId(position.deviceId);
      updatedState.tripStartTime = position.timestamp;
      updatedState.tripStartLat = position.latitude;
      updatedState.tripStartLon = position.longitude;
      updatedState.tripDistance = 0;
      updatedState.tripMaxSpeed = position.speed;
      updatedState.tripStopsCount = 0;
      updatedState.tripConfirmed = false;
      updatedState.tripMaxDistanceFromOrigin = 0;
      updatedState.tripBoundingBox = {
        minLat: position.latitude,
        maxLat: position.latitude,
        minLon: position.longitude,
        maxLon: position.longitude,
      };
      updatedState.tripSpeedSum = position.speed;
      updatedState.tripPositionCount = 1;
      updatedState.tripQualityMetrics = {
        segmentsTotal: 0,
        segmentsAdjusted: 0,
        originalDistance: 0,
        adjustedDistance: 0,
        gpsNoiseSegments: 0,
      };
    }

    // Snapshot del stop anterior ANTES de que startStop lo sobrescriba (cierre+inicio simultáneos,
    // p. ej. IDLE↔STOPPED). Sin esto el stop real queda huérfano con duration=0.
    let previousStop: IStateTransitionResult['previousStop'] = undefined;
    if (
      actions.endStop &&
      actions.startStop &&
      updatedState.currentStopId &&
      updatedState.stopStartTime !== undefined
    ) {
      previousStop = {
        stopId: updatedState.currentStopId,
        startTime: updatedState.stopStartTime,
        startLat: updatedState.stopStartLat ?? updatedState.lastLat,
        startLon: updatedState.stopStartLon ?? updatedState.lastLon,
        reason: updatedState.stopReason,
        metadata: updatedState.stopMetadata,
      };
    }

    // Finalizar stop: NO limpiar datos aquí (position-processor los necesita para el evento)
    if (actions.endStop && updatedState.currentStopId) {
      if (updatedState.currentTripId) {
        updatedState.tripStopsCount = (updatedState.tripStopsCount || 0) + 1;
      }
    }

    // Inicializar stop si es necesario.
    // gapOverride.stopStart: stop de "gap" (no-data) backdateado al inicio del silencio.
    if (actions.startStop) {
      const ss = gapOverride?.stopStart;
      updatedState.currentStopId = this.generateStopId(position.deviceId);
      updatedState.stopStartTime = ss?.time ?? position.timestamp;
      updatedState.stopStartLat = ss?.lat ?? position.latitude;
      updatedState.stopStartLon = ss?.lon ?? position.longitude;
      updatedState.stopReason = ss?.reason ?? this.determineStopReason(newState, position);
    }

    return {
      previousState,
      newState,
      transitionOccurred: newState !== previousState,
      reason: this.getTransitionReason(position, previousState, newState),
      actions,
      updatedState,
      previousTrip,
      previousStop,
      overnightGap,
      tripClosure,
      closedGapStop: gapOverride?.closedGapStop,
    };
  }

  /**
   * Maneja la primera posición de un dispositivo
   */
  private handleFirstPosition(
    position: IPositionEvent,
    ignitionContext?: IIgnitionContext,
  ): IStateTransitionResult {
    const useIgnition = this.shouldUseIgnition(ignitionContext);
    const state: MotionState = useIgnition
      ? position.ignition
        ? position.speed >= this.thresholds.minMovingSpeed
          ? MotionState.MOVING
          : MotionState.IDLE
        : MotionState.STOPPED
      : position.speed >= this.thresholds.minMovingSpeed
        ? MotionState.MOVING
        : MotionState.STOPPED;

    const deviceState: IDeviceMotionState = {
      deviceId: position.deviceId,
      state,
      stateStartTime: position.timestamp,
      lastTimestamp: position.timestamp,
      lastLat: position.latitude,
      lastLon: position.longitude,
      lastSpeed: position.speed,
      lastIgnition: position.ignition ?? false,
      lastUpdate: Date.now(),
      version: 1,
      recentPositions: [
        {
          timestamp: position.timestamp,
          lat: position.latitude,
          lon: position.longitude,
          speed: position.speed,
          ignition: position.ignition ?? false,
        },
      ],
    };

    const actions = {
      startTrip: state === MotionState.MOVING,
      updateTrip: false,
      endTrip: false,
      discardTrip: false,
      startStop: state === MotionState.STOPPED || state === MotionState.IDLE,
      endStop: false,
    };

    if (actions.startTrip) {
      deviceState.currentTripId = this.generateTripId(position.deviceId);
      deviceState.tripStartTime = position.timestamp;
      deviceState.tripStartLat = position.latitude;
      deviceState.tripStartLon = position.longitude;
      deviceState.tripDistance = 0;
      deviceState.tripMaxSpeed = position.speed;
      deviceState.tripStopsCount = 0;
      // Inicializar contexto para detección de ruido GPS
      deviceState.tripMaxDistanceFromOrigin = 0;
      deviceState.tripBoundingBox = {
        minLat: position.latitude,
        maxLat: position.latitude,
        minLon: position.longitude,
        maxLon: position.longitude,
      };
      deviceState.tripSpeedSum = position.speed;
      deviceState.tripPositionCount = 1;
      deviceState.tripQualityMetrics = {
        segmentsTotal: 0,
        segmentsAdjusted: 0,
        originalDistance: 0,
        adjustedDistance: 0,
        gpsNoiseSegments: 0,
      };
    }

    if (actions.startStop) {
      const stopReason = this.determineStopReason(state, position);
      deviceState.currentStopId = this.generateStopId(position.deviceId);
      deviceState.stopStartTime = position.timestamp;
      deviceState.stopStartLat = position.latitude;
      deviceState.stopStartLon = position.longitude;
      deviceState.stopReason = stopReason;
    }

    return {
      previousState: MotionState.UNKNOWN,
      newState: state,
      transitionOccurred: true,
      reason: position.ignition
        ? DetectionReason.IGNITION_ON
        : DetectionReason.IGNITION_OFF,
      actions,
      updatedState: deviceState,
    };
  }

  /**
   * Determina el nuevo estado basado en la posición actual.
   *
   * Modo "Ignition-First" (device con sensor de ignición activo):
   * 1. ignition OFF → STOPPED siempre
   * 2. ignition ON + speed >= umbral → MOVING
   * 3. ignition ON + speed < umbral → IDLE
   *
   * Modo "Motion-Only" (device sin sensor o con sensor expirado):
   * 1. speed >= umbral → MOVING
   * 2. speed < umbral → STOPPED (no hay IDLE sin ignición)
   */
  private determineState(
    position: IPositionEvent,
    currentState: IDeviceMotionState,
    ignitionContext?: IIgnitionContext,
  ): MotionState {
    const useIgnition = this.shouldUseIgnition(ignitionContext);

    // Velocidad EFECTIVA = max(speed reportado, velocidad implícita por GPS).
    // Colchón para trackers que reportan speed=0 estando en movimiento: si el desplazamiento
    // GPS entre posiciones implica una velocidad mayor, se usa esa. Evita paradas fantasma.
    const effSpeed = this.effectiveSpeed(position, currentState);

    const cameFromStop =
      currentState.state === MotionState.STOPPED ||
      currentState.state === MotionState.IDLE;

    // El promedio (speedAvg30s) queda OBSOLETO tras un gap grande: refleja el último tramo
    // reportado (p. ej. manejando antes de un silencio nocturno), no el instante actual. Con el
    // MISMO cutoff que effectiveSpeed (dt>300s) se descarta el avg viejo y se decide por la
    // velocidad efectiva instantánea. Sin esto, un auto que reaparece detenido tras un gap largo
    // queda "MOVING" por el avg stale (cae en `return currentState.state`) → nunca pasa a
    // STOPPED/IDLE y no se detecta la parada nocturna (no-data gap).
    const dtSec = (position.timestamp - currentState.lastTimestamp) / 1000;
    const avgSpeed =
      dtSec > 300 ? effSpeed : (currentState.speedAvg30s ?? effSpeed);

    if (!useIgnition) {
      // Motion-only: decidir solo por velocidad
      const isMoving = effSpeed >= this.thresholds.minMovingSpeed;
      const isMovingByAvg = avgSpeed >= this.thresholds.minMovingSpeed;

      // Reanudación responsiva: si venimos de detenido y hay movimiento instantáneo claro,
      // pasar a MOVING ya (sin esperar el promedio). Cierra el stop cuando el vehículo
      // realmente arranca, no ~90s después. La vuelta a STOPPED sigue siendo conservadora
      // (exige instantáneo Y promedio bajos), lo que evita flapping en stop-and-go.
      if (cameFromStop && isMoving) return MotionState.MOVING;
      if (isMoving && isMovingByAvg) return MotionState.MOVING;
      if (!isMoving && !isMovingByAvg) return MotionState.STOPPED;
      return currentState.state;
    }

    // Ignition-First: Si ignición OFF → normalmente STOPPED.
    // EXCEPCIÓN: si el GPS muestra movimiento sostenido (velocidad efectiva instantánea Y
    // promedio >= umbral), es un glitch del sensor de ignición (reporta OFF mientras el
    // vehículo se mueve). No forzar STOPPED — tratarlo como MOVING. Evita "paradas" de
    // ignition_off mientras el auto va a 90 km/h.
    if (!position.ignition) {
      if (
        effSpeed >= this.thresholds.minMovingSpeed &&
        avgSpeed >= this.thresholds.minMovingSpeed
      ) {
        return MotionState.MOVING;
      }
      return MotionState.STOPPED;
    }

    // Ignición ON - evaluar velocidad
    const isMoving = effSpeed >= this.thresholds.minMovingSpeed;
    const isMovingByAvg = avgSpeed >= this.thresholds.minMovingSpeed;

    // Reanudación responsiva desde detenido (ver nota en la rama motion-only).
    if (cameFromStop && isMoving) return MotionState.MOVING;
    if (isMoving && isMovingByAvg) return MotionState.MOVING;
    if (!isMoving && !isMovingByAvg) return MotionState.IDLE;
    return currentState.state;
  }

  /**
   * Velocidad efectiva (km/h) = max(speed reportado, velocidad implícita por GPS).
   * La implícita se calcula desde el desplazamiento entre la última posición y la actual.
   * Se ignora si el gap es grande (>5min, relocalización por pérdida de señal) o si da una
   * velocidad imposible (>200 km/h, salto GPS), para no forzar MOVING por ruido.
   */
  private effectiveSpeed(
    position: IPositionEvent,
    currentState: IDeviceMotionState,
  ): number {
    const dt = (position.timestamp - currentState.lastTimestamp) / 1000;
    if (dt <= 0 || dt > 300) return position.speed;
    const dist = this.calculateDistance(
      currentState.lastLat,
      currentState.lastLon,
      position.latitude,
      position.longitude,
    );
    const impliedKmh = (dist / dt) * 3.6;
    if (impliedKmh > this.thresholds.minMovingSpeed && impliedKmh <= 200) {
      return Math.max(position.speed, impliedKmh);
    }
    return position.speed;
  }

  /**
   * Determina si debe usarse ignition-first o motion-only para este device.
   * Usa ignition-first solo si el device tuvo ignición Y la última vez
   * que llegó ignition=true fue dentro del período de expiración configurado.
   */
  private shouldUseIgnition(ignitionContext?: IIgnitionContext): boolean {
    if (!ignitionContext?.hasIgnition) return false;
    if (!ignitionContext.lastIgnitionSeenAt) return false;

    const expiryMs = IGNITION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    const lastSeen = new Date(ignitionContext.lastIgnitionSeenAt);
    const elapsed = Date.now() - lastSeen.getTime();
    return elapsed < expiryMs;
  }

  /**
   * Actualiza el estado del dispositivo con la nueva posición
   */
  private updateState(
    position: IPositionEvent,
    currentState: IDeviceMotionState,
    newState: MotionState,
  ): IDeviceMotionState {
    // Actualizar buffer de posiciones recientes.
    // Se guarda la velocidad EFECTIVA (max reportado / implícita GPS) para que los promedios
    // (speedAvg30s, etc.) también reflejen el movimiento real cuando el tracker reporta speed=0.
    const recentPositions = [
      ...(currentState.recentPositions || []),
      {
        timestamp: position.timestamp,
        lat: position.latitude,
        lon: position.longitude,
        speed: this.effectiveSpeed(position, currentState),
        ignition: position.ignition ?? false,
      },
    ];

    // Mantener solo las últimas N posiciones
    if (recentPositions.length > this.thresholds.positionBufferSize) {
      recentPositions.shift();
    }

    // Calcular promedios de velocidad
    const now = position.timestamp;
    const speedAvg30s = this.calculateAverageSpeed(recentPositions, now, 30);
    const speedAvg1min = this.calculateAverageSpeed(recentPositions, now, 60);
    const speedAvg5min = this.calculateAverageSpeed(recentPositions, now, 300);

    const updatedState: IDeviceMotionState = {
      ...currentState,
      state: newState,
      lastTimestamp: position.timestamp,
      lastLat: position.latitude,
      lastLon: position.longitude,
      lastSpeed: position.speed,
      lastIgnition: position.ignition ?? false,
      speedAvg30s,
      speedAvg1min,
      speedAvg5min,
      recentPositions,
      lastUpdate: Date.now(),
      version: currentState.version + 1,
    };

    // Si hay trip activo, actualizar métricas
    if (currentState.currentTripId) {
      // Construir contexto del trip para detección de ruido GPS
      const tripContext = {
        startLat: currentState.tripStartLat || currentState.lastLat,
        startLon: currentState.tripStartLon || currentState.lastLon,
        currentDistance: currentState.tripDistance || 0,
        startTime: currentState.tripStartTime || currentState.lastTimestamp,
        maxDistanceFromOrigin: currentState.tripMaxDistanceFromOrigin || 0,
        boundingBox: currentState.tripBoundingBox || {
          minLat: currentState.tripStartLat || currentState.lastLat,
          maxLat: currentState.tripStartLat || currentState.lastLat,
          minLon: currentState.tripStartLon || currentState.lastLon,
          maxLon: currentState.tripStartLon || currentState.lastLon,
        },
        speedSum: currentState.tripSpeedSum || 0,
        positionCount: currentState.tripPositionCount || 0,
      };

      // Validar segmento GPS (detecta ruido GPS)
      const validation = this.distanceValidator.validateSegment(
        {
          lat: currentState.lastLat,
          lon: currentState.lastLon,
          timestamp: currentState.lastTimestamp,
          speed: currentState.lastSpeed,
          ignition: currentState.lastIgnition,
        },
        {
          lat: position.latitude,
          lon: position.longitude,
          timestamp: position.timestamp,
          speed: position.speed,
          ignition: position.ignition ?? false,
        },
        tripContext,
      );

      // Actualizar contexto del trip con la nueva posición
      const updatedContext = this.distanceValidator.updateTripContext(
        tripContext,
        {
          lat: position.latitude,
          lon: position.longitude,
          timestamp: position.timestamp,
          speed: position.speed,
          ignition: position.ignition ?? false,
        },
      );

      // Aplicar contexto actualizado al estado
      updatedState.tripMaxDistanceFromOrigin =
        updatedContext.maxDistanceFromOrigin;
      updatedState.tripBoundingBox = updatedContext.boundingBox;
      updatedState.tripSpeedSum = updatedContext.speedSum;
      updatedState.tripPositionCount = updatedContext.positionCount;

      // Usar distancia ajustada (0 si es ruido GPS, completa si es movimiento real)
      updatedState.tripDistance =
        (currentState.tripDistance || 0) + validation.adjustedDistance;

      updatedState.tripMaxSpeed = Math.max(
        currentState.tripMaxSpeed || 0,
        position.speed,
      );

      // Inicializar o actualizar metadata de calidad del trip
      if (!updatedState.tripQualityMetrics) {
        updatedState.tripQualityMetrics = {
          segmentsTotal: 0,
          segmentsAdjusted: 0,
          originalDistance: 0,
          adjustedDistance: 0,
          gpsNoiseSegments: 0,
        };
      }

      updatedState.tripQualityMetrics.segmentsTotal++;
      updatedState.tripQualityMetrics.originalDistance +=
        validation.originalDistance;
      updatedState.tripQualityMetrics.adjustedDistance +=
        validation.adjustedDistance;

      // Registrar si fue ruido GPS
      if (validation.metadata.isGpsNoise) {
        updatedState.tripQualityMetrics.gpsNoiseSegments++;
        updatedState.tripQualityMetrics.segmentsAdjusted++;
      } else if (!validation.isValid) {
        updatedState.tripQualityMetrics.segmentsAdjusted++;
      }
    }

    // Si cambió el estado, actualizar stateStartTime
    if (newState !== currentState.state) {
      updatedState.stateStartTime = position.timestamp;
    }

    return updatedState;
  }

  /**
   * Determina las acciones a ejecutar basado en la transición de estados
   */
  private determineActions(
    previousState: MotionState,
    newState: MotionState,
    updatedState: IDeviceMotionState,
  ): IStateTransitionResult['actions'] {
    const actions: IStateTransitionResult['actions'] = {
      startTrip: false,
      endTrip: false,
      discardTrip: false,
      updateTrip: false,
      startStop: false,
      endStop: false,
    };

    // STOPPED/IDLE → MOVING: Evaluar si iniciar nuevo trip
    if (
      (previousState === MotionState.STOPPED ||
        previousState === MotionState.IDLE) &&
      newState === MotionState.MOVING
    ) {
      // Calcular duración del stop actual (si existe)
      const stopDuration =
        updatedState.currentStopId && updatedState.stopStartTime
          ? (updatedState.lastTimestamp - updatedState.stopStartTime) / 1000
          : 0;

      // Solo crear nuevo trip si:
      // 1. No hay trip activo (primer trip del dispositivo), O
      // 2. El stop duró >= minStopDuration (5 min por defecto - igual que Traccar)
      //
      // Esto evita sobre-segmentación de trips por paradas cortas (ej: semáforos, entregas rápidas, etc.)
      const shouldStartNewTrip =
        !updatedState.currentTripId ||
        stopDuration >= this.thresholds.minStopDuration;

      if (shouldStartNewTrip) {
        // Si había un trip activo previo, finalizarlo antes de crear uno nuevo
        if (updatedState.currentTripId) {
          const tripDuration =
            (updatedState.lastTimestamp - (updatedState.tripStartTime || 0)) /
            1000;
          const tripDistance = updatedState.tripDistance || 0;

          // Validar si el trip cumple con los mínimos para ser guardado
          if (
            tripDuration >= this.thresholds.minTripDuration &&
            tripDistance >= this.thresholds.minTripDistance
          ) {
            actions.endTrip = true;
            this.logger.log(
              `Closing trip for device ${updatedState.deviceId} after ${Math.round(stopDuration)}s stop: duration=${tripDuration.toFixed(1)}s, distance=${Math.round(tripDistance)}m`,
            );
          } else {
            // Trip muy corto, marcarlo para cerrar sin guardar
            actions.discardTrip = true;
            this.logger.debug(
              `Discarding short trip for device ${updatedState.deviceId}: duration=${tripDuration.toFixed(1)}s, distance=${Math.round(tripDistance)}m`,
            );
          }
        }

        actions.startTrip = true;
        this.logger.log(
          `Starting new trip for device ${updatedState.deviceId} after ${Math.round(stopDuration)}s stop (>= ${this.thresholds.minStopDuration}s threshold)`,
        );
      } else {
        // Stop muy corto - NO crear nuevo trip, continuar el actual
        this.logger.debug(
          `Continuing trip for device ${updatedState.deviceId} after short ${Math.round(stopDuration)}s stop (< ${this.thresholds.minStopDuration}s threshold)`,
        );
      }

      // Siempre finalizar el stop (sea corto o largo) para evitar stops activos acumulados
      if (updatedState.currentStopId) {
        actions.endStop = true;
      }
    }

    // MOVING → STOPPED: Iniciar stop (NO finalizar trip aún)
    // El trip se finalizará cuando se reanude el movimiento solo si el stop duró >= minStopDuration
    if (
      previousState === MotionState.MOVING &&
      newState === MotionState.STOPPED
    ) {
      // Iniciar stop - el trip continúa abierto hasta que se determine si el stop es lo suficientemente largo
      actions.startStop = true;

      this.logger.debug(
        `Vehicle stopped for device ${updatedState.deviceId}, trip continues (will close if stop >= ${this.thresholds.minStopDuration}s)`,
      );
    }

    // MOVING → IDLE: Iniciar stop (dentro de trip, motor encendido pero sin movimiento)
    if (previousState === MotionState.MOVING && newState === MotionState.IDLE) {
      actions.startStop = true;
    }

    // IDLE → MOVING: Finalizar stop
    if (previousState === MotionState.IDLE && newState === MotionState.MOVING) {
      actions.endStop = true;
    }

    // IDLE ↔ STOPPED: el vehículo SIGUE detenido (ambos estados son vel < minMovingSpeed,
    // no hubo movimiento). NO fragmentar la parada por toggles de ignición (motor que se
    // prende/apaga estando estacionado): se mantiene el MISMO stop abierto.
    // Antes cada cambio de contacto cerraba y abría un stop nuevo → una parada continua en
    // el mismo lugar quedaba partida en varios stops (no_movement/ignition_off alternados).
    // La parada solo se cierra cuando el vehículo se MUEVE (IDLE/STOPPED → MOVING).
    // Si por algún motivo no había stop abierto, se abre uno.
    if (
      (previousState === MotionState.IDLE &&
        newState === MotionState.STOPPED) ||
      (previousState === MotionState.STOPPED && newState === MotionState.IDLE)
    ) {
      if (!updatedState.currentStopId) {
        actions.startStop = true;
      }
      // Si ya hay stop, no se setean endStop/startStop → se preserva la parada en curso.
    }

    // MOVING: Actualizar trip en curso
    if (newState === MotionState.MOVING && updatedState.currentTripId) {
      actions.updateTrip = true;
    }

    // IDLE prolongado: Si el vehículo está en IDLE por más de maxIdleDuration, cerrar el trip
    // Esto evita trips "fantasma" que quedan abiertos indefinidamente cuando el vehículo
    // tiene motor encendido pero no se mueve (ej: estacionado con motor encendido)
    if (
      newState === MotionState.IDLE &&
      updatedState.currentTripId &&
      updatedState.stateStartTime
    ) {
      const idleDuration =
        (updatedState.lastTimestamp - updatedState.stateStartTime) / 1000;

      if (idleDuration >= this.thresholds.maxIdleDuration) {
        const tripDuration =
          (updatedState.lastTimestamp - (updatedState.tripStartTime || 0)) /
          1000;
        const tripDistance = updatedState.tripDistance || 0;

        // Validar si el trip cumple con los mínimos para ser guardado
        if (
          tripDuration >= this.thresholds.minTripDuration &&
          tripDistance >= this.thresholds.minTripDistance
        ) {
          actions.endTrip = true;
          this.logger.log(
            `Closing trip for device ${updatedState.deviceId} after ${Math.round(idleDuration)}s IDLE: ` +
              `duration=${tripDuration.toFixed(1)}s, distance=${Math.round(tripDistance)}m ` +
              `(maxIdleDuration=${this.thresholds.maxIdleDuration}s exceeded)`,
          );
        } else {
          // Trip muy corto, marcarlo para cerrar sin guardar
          actions.discardTrip = true;
          this.logger.debug(
            `Discarding trip for device ${updatedState.deviceId} after ${Math.round(idleDuration)}s IDLE: ` +
              `duration=${tripDuration.toFixed(1)}s, distance=${Math.round(tripDistance)}m (below minimums)`,
          );
        }

        // NO cerrar el stop aquí - el stop se cerrará naturalmente cuando:
        // 1. El vehículo vuelva a moverse (IDLE → MOVING)
        // 2. La ignición se apague (IDLE → STOPPED)
        // 3. El orphan cleanup lo cierre si queda huérfano por mucho tiempo
        // Esto evita stops con duración artificial de exactamente maxIdleDuration
      }
    }

    // Cierre de trip "estilo Traccar": cuando el vehículo lleva DETENIDO (STOPPED) por
    // >= minStopDuration con un trip aún abierto, cerrar el trip. El trip termina en el
    // INICIO de la parada (lo setea applyTransition vía tripClosure), de modo que el tiempo
    // estacionado pertenece al stop y la próxima salida genera un trip nuevo limpio.
    // (Antes el trip quedaba abierto durante todo el estacionamiento y se cerraba al
    // reanudar — o en un gap — "comiéndose" las horas detenido.)
    if (
      newState === MotionState.STOPPED &&
      updatedState.currentTripId &&
      updatedState.currentStopId &&
      updatedState.stopStartTime !== undefined &&
      !actions.endTrip &&
      !actions.discardTrip
    ) {
      const parkedSec =
        (updatedState.lastTimestamp - updatedState.stopStartTime) / 1000;
      if (parkedSec >= this.thresholds.minStopDuration) {
        const tripDuration =
          (updatedState.stopStartTime - (updatedState.tripStartTime || 0)) /
          1000;
        const tripDistance = updatedState.tripDistance || 0;
        if (
          tripDuration >= this.thresholds.minTripDuration &&
          tripDistance >= this.thresholds.minTripDistance
        ) {
          actions.endTrip = true;
          this.logger.log(
            `Closing trip for device ${updatedState.deviceId} at parking start ` +
              `(stopped ${Math.round(parkedSec)}s >= ${this.thresholds.minStopDuration}s): ` +
              `trip duration=${tripDuration.toFixed(0)}s, distance=${Math.round(tripDistance)}m`,
          );
        } else {
          actions.discardTrip = true;
        }
      }
    }

    return actions;
  }

  /**
   * Maneja gaps temporales grandes (pérdida de señal GPS)
   *
   * Casos de cierre de trip:
   * 1. Stop activo >= minStopDuration (5 min) - comportamiento normal
   * 2. Gap >= maxOvernightGapDuration (2h) - fuerza cierre sin importar stop
   *    (cubre casos donde tracker se apaga sin transición a STOPPED)
   */
  private handleLargeGap(
    position: IPositionEvent,
    currentState: IDeviceMotionState,
    ignitionContext?: IIgnitionContext,
  ): IStateTransitionResult {
    const gapDuration =
      (position.timestamp - currentState.lastTimestamp) / 1000;
    const isOvernightGap =
      gapDuration >= this.thresholds.maxOvernightGapDuration;

    const previousState = currentState.state;
    const newState = this.determineState(
      position,
      currentState,
      ignitionContext,
    );
    const updatedState = this.updateState(position, currentState, newState);

    // CLAVE: usar la MISMA lógica de transiciones que el flujo normal, NO resetear como
    // "primera posición". Si el vehículo sigue detenido a través del gap (reportes espaciados
    // de un vehículo estacionado), determineActions no devuelve acciones de stop → el stop
    // en curso se PRESERVA en vez de fragmentarse/orfanarse. Antes (reset) cada gap >10min
    // abandonaba el stop abierto y abría uno nuevo, partiendo una parada larga en pedazos
    // que nunca cerraban (is_active=true) o quedaban con duración negativa.
    const actions = this.determineActions(
      previousState,
      newState,
      updatedState,
    );

    // Datos del inicio del silencio (última posición conocida antes del gap).
    const gapStartMs = currentState.lastTimestamp;
    const gapStartLat = currentState.lastLat;
    const gapStartLon = currentState.lastLon;
    const hadOpenStop = !!currentState.currentStopId;
    let gapOverride:
      | {
          tripEnd?: { endTime: number; endLat: number; endLon: number };
          stopStart?: { time: number; lat: number; lon: number; reason: 'gap' };
          closedGapStop?: {
            startTime: number;
            startLat: number;
            startLon: number;
            endTime: number;
            endLat: number;
            endLon: number;
          };
        }
      | undefined = undefined;

    // Gap nocturno: forzar cierre del trip aunque no haya transición a STOPPED
    // (cubre trackers que se apagan sin reportar el cambio de estado).
    if (
      isOvernightGap &&
      updatedState.currentTripId &&
      !actions.endTrip &&
      !actions.discardTrip &&
      !actions.startTrip
    ) {
      const tripDuration = (gapStartMs - (updatedState.tripStartTime || 0)) / 1000;
      const tripDistance = updatedState.tripDistance || 0;
      if (
        tripDuration >= this.thresholds.minTripDuration &&
        tripDistance >= this.thresholds.minTripDistance
      ) {
        actions.endTrip = true;
      } else {
        actions.discardTrip = true;
      }
    }

    if (isOvernightGap) {
      // El trip cerrado por el gap termina al cortarse el reporte, no en la reanudación.
      if (actions.endTrip || actions.discardTrip) {
        gapOverride = {
          tripEnd: {
            endTime: gapStartMs,
            endLat: gapStartLat,
            endLon: gapStartLon,
          },
        };
      }
      // No-data gap = parada (estilo Traccar `minimalNoDataDuration`): si NO había stop abierto
      // (el vehículo venía en movimiento) y reanuda detenido, crear un stop 'gap' backdateado
      // al inicio del silencio. Así el período sin datos queda como PARADA, no como hueco.
      // (Si ya había un stop abierto, se preserva a través del gap por la lógica normal.)
      if (!hadOpenStop) {
        // Solo cuenta como parada si REAPARECE CERCA del último punto (el vehículo se quedó
        // quieto durante el silencio). Si reaparece lejos, se movió mientras no reportaba →
        // no se puede afirmar que estuvo detenido → no se crea parada (queda gap/hueco).
        const GAP_PARKING_MAX_MOVE_M = 100;
        const moveDist = this.calculateDistance(
          gapStartLat,
          gapStartLon,
          position.latitude,
          position.longitude,
        );
        if (moveDist <= GAP_PARKING_MAX_MOVE_M) {
          if (
            newState === MotionState.STOPPED ||
            newState === MotionState.IDLE
          ) {
            // Reanuda DETENIDO: parada 'gap' ABIERTA backdateada al inicio del silencio;
            // se cerrará cuando el vehículo vuelva a moverse.
            actions.startStop = true;
            gapOverride = {
              ...(gapOverride || {}),
              stopStart: {
                time: gapStartMs,
                lat: gapStartLat,
                lon: gapStartLon,
                reason: 'gap',
              },
            };
          } else {
            // Reanuda EN MOVIMIENTO: el silencio fue una parada completa. Se emite una
            // parada 'gap' CERRADA (inicio del silencio → reanudación). El trip nuevo
            // arranca en la reanudación por la transición normal a MOVING (startTrip).
            gapOverride = {
              ...(gapOverride || {}),
              closedGapStop: {
                startTime: gapStartMs,
                startLat: gapStartLat,
                startLon: gapStartLon,
                endTime: position.timestamp,
                endLat: position.latitude,
                endLon: position.longitude,
              },
            };
          }
          this.logger.log(
            `No-data gap stop for device ${position.deviceId}: ${Math.round(gapDuration)}s ` +
              `desde ${new Date(gapStartMs).toISOString()} (reaparece a ${Math.round(moveDist)}m, ${newState})`,
          );
        } else {
          this.logger.log(
            `No-data gap for device ${position.deviceId}: ${Math.round(gapDuration)}s pero reaparece ` +
              `a ${Math.round(moveDist)}m (>${GAP_PARKING_MAX_MOVE_M}m) → se movió durante el silencio, sin parada`,
          );
        }
      }
    } else {
      this.logger.debug(
        `Large gap for device ${position.deviceId}: ${Math.round(gapDuration)}s ` +
          `(${previousState} → ${newState}); preservado sin fragmentar`,
      );
    }

    return this.applyTransition(
      position,
      previousState,
      newState,
      updatedState,
      actions,
      isOvernightGap
        ? { detected: true, durationSeconds: gapDuration }
        : undefined,
      gapOverride,
    );
  }

  /**
   * Calcula distancia entre dos puntos GPS (Haversine)
   * Usa radio ecuatorial WGS84 para máxima precisión GPS
   */
  private calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    // Radio ecuatorial WGS84 (estándar GPS) - más preciso que radio medio
    // Antes: 6371000 (radio medio) - Ahora: 6378137 (WGS84) = +0.11% precisión
    const R = 6378137; // Radio ecuatorial WGS84 en metros
    const dLat = this.deg2rad(lat2 - lat1);
    const dLon = this.deg2rad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.deg2rad(lat1)) *
        Math.cos(this.deg2rad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distancia en metros
  }

  private deg2rad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  /**
   * Calcula velocidad promedio en una ventana de tiempo
   */
  private calculateAverageSpeed(
    positions: Array<{ timestamp: number; speed: number }>,
    currentTime: number,
    windowSeconds: number,
  ): number {
    const windowStart = currentTime - windowSeconds * 1000;
    const relevantPositions = positions.filter(
      (p) => p.timestamp >= windowStart,
    );

    if (relevantPositions.length === 0) return 0;

    const sum = relevantPositions.reduce((acc, p) => acc + p.speed, 0);
    return sum / relevantPositions.length;
  }

  /**
   * Genera ID único para trip
   */
  private generateTripId(deviceId: string): string {
    return `trip_${deviceId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Genera ID único para stop
   */
  private generateStopId(deviceId: string): string {
    return `stop_${deviceId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Determina la razón del stop basándose en el estado y la posición
   */
  private determineStopReason(
    state: MotionState,
    position: IPositionEvent,
  ): 'ignition_off' | 'no_movement' | 'parking' {
    // Si ignición OFF → parada por ignición apagada
    if (!position.ignition) {
      return 'ignition_off';
    }

    // Si ignición ON pero sin movimiento → parada por falta de movimiento (ej: semáforo, tráfico)
    if (state === MotionState.IDLE) {
      return 'no_movement';
    }

    // Por defecto, parking
    return 'parking';
  }

  /**
   * Determina la razón de la transición
   */
  private getTransitionReason(
    position: IPositionEvent,
    previousState: MotionState,
    newState: MotionState,
  ): DetectionReason {
    if (
      previousState === MotionState.STOPPED &&
      newState === MotionState.MOVING
    ) {
      return position.ignition
        ? DetectionReason.IGNITION_ON
        : DetectionReason.MOTION_DETECTED;
    }

    if (
      previousState === MotionState.MOVING &&
      newState === MotionState.STOPPED
    ) {
      return !position.ignition
        ? DetectionReason.IGNITION_OFF
        : DetectionReason.MOTION_STOPPED;
    }

    return DetectionReason.THRESHOLD_REACHED;
  }
}
