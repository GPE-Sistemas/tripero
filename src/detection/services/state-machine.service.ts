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

  // Información de overnight gap (para tracking de problemas de energía)
  overnightGap?: {
    detected: boolean;
    durationSeconds: number;
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
  ): IStateTransitionResult {
    // Si no hay estado previo, crear uno inicial
    if (!currentState) {
      return this.handleFirstPosition(position);
    }

    // Validar gap temporal
    const gap = position.timestamp - currentState.lastTimestamp;
    if (gap > this.thresholds.maxGapDuration * 1000) {
      this.logger.warn(
        `Large time gap detected for device ${position.deviceId}: ${gap}ms`,
      );
      return this.handleLargeGap(position, currentState);
    }

    // Determinar nuevo estado basado en ignición y velocidad
    const newState = this.determineState(position, currentState);
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

    // IMPORTANTE: Guardar datos del trip anterior ANTES de inicializar el nuevo
    // para evitar pérdida de datos cuando ambos endTrip/discardTrip y startTrip son true
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

    // Inicializar trip si es necesario
    if (actions.startTrip) {
      updatedState.currentTripId = this.generateTripId(position.deviceId);
      updatedState.tripStartTime = position.timestamp;
      updatedState.tripStartLat = position.latitude;
      updatedState.tripStartLon = position.longitude;
      updatedState.tripDistance = 0;
      updatedState.tripMaxSpeed = position.speed;
      updatedState.tripStopsCount = 0;
      updatedState.tripConfirmed = false; // Trip no confirmado hasta cumplir mínimos
      // Inicializar contexto para detección de ruido GPS
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

    // Finalizar stop si es necesario
    // NOTA: NO limpiar datos del stop aquí - position-processor lo hará después de publicar el evento
    if (actions.endStop && updatedState.currentStopId) {
      // Incrementar contador de stops si estamos dentro de un trip
      if (updatedState.currentTripId) {
        updatedState.tripStopsCount = (updatedState.tripStopsCount || 0) + 1;
      }

      // NO limpiar datos aquí - position-processor necesita esta info para el evento
      // updatedState.currentStopId = undefined;
      // updatedState.stopStartTime = undefined;
      // updatedState.stopStartLat = undefined;
      // updatedState.stopStartLon = undefined;
      // updatedState.stopReason = undefined;
    }

    // Inicializar stop si es necesario
    if (actions.startStop) {
      const stopReason = this.determineStopReason(newState, position);
      updatedState.currentStopId = this.generateStopId(position.deviceId);
      updatedState.stopStartTime = position.timestamp;
      updatedState.stopStartLat = position.latitude;
      updatedState.stopStartLon = position.longitude;
      updatedState.stopReason = stopReason;
    }

    const reason = this.getTransitionReason(position, previousState, newState);

    return {
      previousState,
      newState,
      transitionOccurred,
      reason,
      actions,
      updatedState,
      previousTrip,
    };
  }

  /**
   * Maneja la primera posición de un dispositivo
   */
  private handleFirstPosition(
    position: IPositionEvent,
  ): IStateTransitionResult {
    const state: MotionState = position.ignition
      ? position.speed >= this.thresholds.minMovingSpeed
        ? MotionState.MOVING
        : MotionState.IDLE
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
   * Determina el nuevo estado basado en la posición actual
   *
   * Lógica "Ignition-First":
   * 1. Si ignition OFF → STOPPED (sin importar velocidad)
   * 2. Si ignition ON y speed >= umbral → MOVING
   * 3. Si ignition ON y speed < umbral → IDLE
   */
  private determineState(
    position: IPositionEvent,
    currentState: IDeviceMotionState,
  ): MotionState {
    // Ignition-First: Si ignición OFF, siempre STOPPED
    if (!position.ignition) {
      return MotionState.STOPPED;
    }

    // Ignición ON - evaluar velocidad
    const isMoving = position.speed >= this.thresholds.minMovingSpeed;

    // Usar promedio de velocidad si está disponible para suavizar transiciones
    const avgSpeed =
      currentState.speedAvg30s !== undefined
        ? currentState.speedAvg30s
        : position.speed;

    const isMovingByAvg = avgSpeed >= this.thresholds.minMovingSpeed;

    // Si la velocidad actual Y el promedio indican movimiento → MOVING
    if (isMoving && isMovingByAvg) {
      return MotionState.MOVING;
    }

    // Si ambas indican quieto → IDLE (ignición ON pero sin movimiento)
    if (!isMoving && !isMovingByAvg) {
      return MotionState.IDLE;
    }

    // En caso de discrepancia, mantener estado actual para evitar flapping
    return currentState.state;
  }

  /**
   * Actualiza el estado del dispositivo con la nueva posición
   */
  private updateState(
    position: IPositionEvent,
    currentState: IDeviceMotionState,
    newState: MotionState,
  ): IDeviceMotionState {
    // Actualizar buffer de posiciones recientes
    const recentPositions = [
      ...(currentState.recentPositions || []),
      {
        timestamp: position.timestamp,
        lat: position.latitude,
        lon: position.longitude,
        speed: position.speed,
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

    // IDLE → STOPPED: Finalizar stop actual e iniciar nuevo stop por ignición OFF
    if (
      previousState === MotionState.IDLE &&
      newState === MotionState.STOPPED
    ) {
      if (updatedState.currentStopId) {
        actions.endStop = true;
      }
      actions.startStop = true;
    }

    // STOPPED → IDLE: Finalizar stop de ignición e iniciar stop de IDLE
    if (
      previousState === MotionState.STOPPED &&
      newState === MotionState.IDLE
    ) {
      if (updatedState.currentStopId) {
        actions.endStop = true;
      }
      actions.startStop = true;
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
  ): IStateTransitionResult {
    // Calcular duración del gap
    const gapDuration =
      (position.timestamp - currentState.lastTimestamp) / 1000;

    // Calcular duración del stop actual (si existe)
    const stopDuration =
      currentState.currentStopId && currentState.stopStartTime
        ? (position.timestamp - currentState.stopStartTime) / 1000
        : 0;

    // Determinar si es un gap "nocturno" (muy largo, típicamente tracker apagado)
    const isOvernightGap =
      gapDuration >= this.thresholds.maxOvernightGapDuration;

    // Determinar si debemos cerrar el trip
    // Cerrarlo si:
    // 1. Hay un trip activo Y
    // 2. (El stop duró >= minStopDuration O es un gap nocturno)
    //
    // El gap nocturno fuerza el cierre porque indica que el vehículo
    // estuvo inactivo por mucho tiempo (ej: tracker desconectado de noche)
    const shouldCloseTrip =
      !!currentState.currentTripId &&
      (stopDuration >= this.thresholds.minStopDuration || isOvernightGap);

    // Si debemos cerrar el trip, validar si cumple con los mínimos para ser guardado
    let shouldEndTrip = false;
    let shouldDiscardTrip = false;

    if (shouldCloseTrip) {
      const tripDuration =
        (position.timestamp - (currentState.tripStartTime || 0)) / 1000;
      const tripDistance = currentState.tripDistance || 0;

      // Validar mínimos
      if (
        tripDuration >= this.thresholds.minTripDuration &&
        tripDistance >= this.thresholds.minTripDistance
      ) {
        shouldEndTrip = true;
      } else {
        // Trip muy corto, marcarlo para cerrar sin guardar
        shouldDiscardTrip = true;
        this.logger.debug(
          `Discarding short trip for device ${position.deviceId} after gap: ` +
            `duration=${tripDuration.toFixed(1)}s, distance=${Math.round(tripDistance)}m (below minimums)`,
        );
      }
    }

    const actions: IStateTransitionResult['actions'] = {
      endTrip: shouldEndTrip,
      discardTrip: shouldDiscardTrip,
      startTrip: false,
      updateTrip: false,
      startStop: false,
      endStop: !!currentState.currentStopId, // Cerrar stop si existe
    };

    if (shouldEndTrip) {
      if (isOvernightGap && stopDuration < this.thresholds.minStopDuration) {
        this.logger.log(
          `Closing trip for device ${position.deviceId} due to overnight gap: ` +
            `${Math.round(gapDuration)}s gap (>= ${this.thresholds.maxOvernightGapDuration}s threshold), ` +
            `stop was only ${Math.round(stopDuration)}s but gap forces closure`,
        );
      } else {
        this.logger.log(
          `Closing trip for device ${position.deviceId} after ${Math.round(gapDuration)}s gap: ` +
            `stop was ${Math.round(stopDuration)}s (>= ${this.thresholds.minStopDuration}s threshold)`,
        );
      }
    } else if (currentState.currentTripId && !shouldDiscardTrip) {
      this.logger.debug(
        `Keeping trip open for device ${position.deviceId} after ${Math.round(gapDuration)}s gap: ` +
          `stop was ${Math.round(stopDuration)}s (< ${this.thresholds.minStopDuration}s threshold), ` +
          `gap < ${this.thresholds.maxOvernightGapDuration}s overnight threshold`,
      );
    }

    // Reiniciar como si fuera primera posición
    const firstPosResult = this.handleFirstPosition(position);

    // Si decidimos NO cerrar el trip (ni guardarlo ni descartarlo), restaurar los datos del trip en el estado
    if (!shouldEndTrip && !shouldDiscardTrip && currentState.currentTripId) {
      firstPosResult.updatedState.currentTripId = currentState.currentTripId;
      firstPosResult.updatedState.tripStartTime = currentState.tripStartTime;
      firstPosResult.updatedState.tripStartLat = currentState.tripStartLat;
      firstPosResult.updatedState.tripStartLon = currentState.tripStartLon;
      firstPosResult.updatedState.tripDistance = currentState.tripDistance;
      firstPosResult.updatedState.tripMaxSpeed = currentState.tripMaxSpeed;
      firstPosResult.updatedState.tripStopsCount = currentState.tripStopsCount;
      firstPosResult.updatedState.tripMetadata = currentState.tripMetadata;
    }

    return {
      ...firstPosResult,
      actions: {
        ...actions,
        ...firstPosResult.actions,
      },
      // Agregar información de overnight gap para tracking de problemas de energía
      overnightGap: isOvernightGap
        ? {
            detected: true,
            durationSeconds: gapDuration,
          }
        : undefined,
    };
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
