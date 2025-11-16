import { Injectable, Logger } from '@nestjs/common';
import {
  MotionState,
  DetectionReason,
  IDeviceMotionState,
  IDetectionThresholds,
  DEFAULT_THRESHOLDS,
} from '../models';
import { IPositionEvent } from '../../interfaces';

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
    startStop?: boolean;
    endStop?: boolean;
    updateTrip?: boolean;
  };

  // Estado actualizado
  updatedState: IDeviceMotionState;
}

@Injectable()
export class StateMachineService {
  private readonly logger = new Logger(StateMachineService.name);
  private readonly thresholds: IDetectionThresholds = DEFAULT_THRESHOLDS;

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

    // Inicializar trip si es necesario
    if (actions.startTrip) {
      updatedState.currentTripId = this.generateTripId(position.deviceId);
      updatedState.tripStartTime = position.timestamp;
      updatedState.tripStartLat = position.latitude;
      updatedState.tripStartLon = position.longitude;
      updatedState.tripDistance = 0;
      updatedState.tripMaxSpeed = position.speed;
      updatedState.tripStopsCount = 0;
    }

    // Finalizar stop si es necesario
    if (actions.endStop && updatedState.currentStopId) {
      // Incrementar contador de stops si estamos dentro de un trip
      if (updatedState.currentTripId) {
        updatedState.tripStopsCount = (updatedState.tripStopsCount || 0) + 1;
      }

      // Limpiar estado de stop
      updatedState.currentStopId = undefined;
      updatedState.stopStartTime = undefined;
      updatedState.stopStartLat = undefined;
      updatedState.stopStartLon = undefined;
      updatedState.stopReason = undefined;
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
    // Calcular distancia desde última posición
    const distance = this.calculateDistance(
      currentState.lastLat,
      currentState.lastLon,
      position.latitude,
      position.longitude,
    );

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
      // Acumular distancia de todos los segmentos del trip, incluyendo el final
      updatedState.tripDistance = (currentState.tripDistance || 0) + distance;
      updatedState.tripMaxSpeed = Math.max(
        currentState.tripMaxSpeed || 0,
        position.speed,
      );
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
      updateTrip: false,
      startStop: false,
      endStop: false,
    };

    // STOPPED/IDLE → MOVING: Iniciar trip
    if (
      (previousState === MotionState.STOPPED ||
        previousState === MotionState.IDLE) &&
      newState === MotionState.MOVING
    ) {
      // Si había un trip activo previo, finalizarlo antes de crear uno nuevo
      // Esto previene la acumulación de trips sin cerrar cuando los dispositivos
      // solo reportan transiciones de velocidad sin eventos de ignición
      if (updatedState.currentTripId) {
        const tripDuration =
          (updatedState.lastTimestamp - (updatedState.tripStartTime || 0)) / 1000;
        const tripDistance = updatedState.tripDistance || 0;

        // Validar si el trip cumple con los mínimos para ser guardado
        if (
          tripDuration >= this.thresholds.minTripDuration &&
          tripDistance >= this.thresholds.minTripDistance
        ) {
          actions.endTrip = true;
          this.logger.log(
            `Auto-closing previous trip for device ${updatedState.deviceId} on new trip start: duration=${tripDuration.toFixed(1)}s, distance=${Math.round(tripDistance)}m`,
          );
        } else {
          // Trip muy corto, marcarlo para cerrar sin guardar
          actions.endTrip = true;
          this.logger.debug(
            `Auto-discarding short trip for device ${updatedState.deviceId} on new trip start: duration=${tripDuration.toFixed(1)}s, distance=${Math.round(tripDistance)}m`,
          );
        }
      }

      actions.startTrip = true;

      // Si había un stop activo, finalizarlo
      if (updatedState.currentStopId) {
        actions.endStop = true;
      }
    }

    // MOVING → STOPPED: Finalizar trip e iniciar stop
    if (previousState === MotionState.MOVING && newState === MotionState.STOPPED) {
      const tripDuration =
        (updatedState.lastTimestamp - (updatedState.tripStartTime || 0)) / 1000;
      const tripDistance = updatedState.tripDistance || 0;

      if (
        tripDuration >= this.thresholds.minTripDuration &&
        tripDistance >= this.thresholds.minTripDistance
      ) {
        actions.endTrip = true;
        this.logger.log(
          `Trip completed for device ${updatedState.deviceId}: duration=${tripDuration.toFixed(1)}s, distance=${Math.round(tripDistance)}m`,
        );
      } else {
        // Trip muy corto, descartarlo
        this.logger.debug(
          `Trip too short for device ${updatedState.deviceId}, discarding: duration=${tripDuration.toFixed(1)}s (min=${this.thresholds.minTripDuration}s), distance=${Math.round(tripDistance)}m (min=${this.thresholds.minTripDistance}m)`,
        );
        actions.endTrip = true; // Cerrar de todos modos pero sin guardar
      }

      // Iniciar stop por ignición OFF
      actions.startStop = true;
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
    if (previousState === MotionState.IDLE && newState === MotionState.STOPPED) {
      if (updatedState.currentStopId) {
        actions.endStop = true;
      }
      actions.startStop = true;
    }

    // STOPPED → IDLE: Finalizar stop de ignición e iniciar stop de IDLE
    if (previousState === MotionState.STOPPED && newState === MotionState.IDLE) {
      if (updatedState.currentStopId) {
        actions.endStop = true;
      }
      actions.startStop = true;
    }

    // MOVING: Actualizar trip en curso
    if (newState === MotionState.MOVING && updatedState.currentTripId) {
      actions.updateTrip = true;
    }

    return actions;
  }

  /**
   * Maneja gaps temporales grandes (pérdida de señal GPS)
   */
  private handleLargeGap(
    position: IPositionEvent,
    currentState: IDeviceMotionState,
  ): IStateTransitionResult {
    // Si había trip activo, cerrarlo
    const actions: IStateTransitionResult['actions'] = {
      endTrip: !!currentState.currentTripId,
      startTrip: false,
      updateTrip: false,
      startStop: false,
      endStop: false,
    };

    // Reiniciar como si fuera primera posición
    const firstPosResult = this.handleFirstPosition(position);

    return {
      ...firstPosResult,
      actions: {
        ...actions,
        ...firstPosResult.actions,
      },
    };
  }

  /**
   * Calcula distancia entre dos puntos GPS (Haversine)
   */
  private calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371000; // Radio de la Tierra en metros
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
    if (previousState === MotionState.STOPPED && newState === MotionState.MOVING) {
      return position.ignition
        ? DetectionReason.IGNITION_ON
        : DetectionReason.MOTION_DETECTED;
    }

    if (previousState === MotionState.MOVING && newState === MotionState.STOPPED) {
      return !position.ignition
        ? DetectionReason.IGNITION_OFF
        : DetectionReason.MOTION_STOPPED;
    }

    return DetectionReason.THRESHOLD_REACHED;
  }
}
