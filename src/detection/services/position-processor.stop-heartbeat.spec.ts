import { Test, TestingModule } from '@nestjs/testing';
import { PositionProcessorService } from './position-processor.service';
import { StateMachineService } from './state-machine.service';
import { DeviceStateService } from './device-state.service';
import { EventPublisherService } from './event-publisher.service';
import { TrackerStateService } from './tracker-state.service';
import { TripRepository } from '../../database/repositories/trip.repository';
import { StopRepository } from '../../database/repositories/stop.repository';
import { IPositionEvent } from '../../interfaces';

/**
 * Regresión: una parada EN CURSO (vehículo estacionado, tracker reportando) debe mantener
 * fresco su updated_at en cada reporte (heartbeat), para que el orphan cleanup NO la cierre
 * como huérfana a los ~30min con duración ~0 (lo que la hacía desaparecer del mapa).
 */
describe('PositionProcessorService — heartbeat de parada en curso', () => {
  let service: PositionProcessorService;
  let stopRepository: { touchStop: jest.Mock };
  let tripRepository: { touchTrip: jest.Mock };
  let stateMachine: { processPosition: jest.Mock };

  const baseActions = {
    startTrip: false,
    endTrip: false,
    discardTrip: false,
    updateTrip: false,
    startStop: false,
    endStop: false,
  };

  beforeEach(async () => {
    stopRepository = { touchStop: jest.fn().mockResolvedValue(undefined) };
    tripRepository = { touchTrip: jest.fn().mockResolvedValue(undefined) };
    stateMachine = { processPosition: jest.fn() };

    const deviceState = {
      isPositionThrottled: jest.fn().mockResolvedValue(false),
      getDeviceState: jest.fn().mockResolvedValue(null),
      saveDeviceState: jest.fn().mockResolvedValue(undefined),
    };
    const trackerState = {
      updateWithPosition: jest.fn().mockResolvedValue(undefined),
      getState: jest.fn().mockResolvedValue({
        hasIgnition: false,
        totalOdometer: 0,
        odometerOffset: 0,
      }),
    };
    const eventPublisher = {
      publishStopStarted: jest.fn().mockResolvedValue(undefined),
      publishStopCompleted: jest.fn().mockResolvedValue(undefined),
      publishTripStarted: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PositionProcessorService,
        { provide: StateMachineService, useValue: stateMachine },
        { provide: DeviceStateService, useValue: deviceState },
        { provide: EventPublisherService, useValue: eventPublisher },
        { provide: TrackerStateService, useValue: trackerState },
        { provide: TripRepository, useValue: tripRepository },
        { provide: StopRepository, useValue: stopRepository },
      ],
    }).compile();

    service = module.get(PositionProcessorService);
  });

  const pos = (o: Partial<IPositionEvent> = {}): IPositionEvent => ({
    deviceId: '869131070495653',
    timestamp: 1_000_000,
    latitude: -34.71,
    longitude: -58.39,
    speed: 0,
    ignition: false,
    ...o,
  });

  it('refresca updated_at del stop en curso (touchStop) al procesar una posición', async () => {
    stateMachine.processPosition.mockReturnValue({
      previousState: 'STOPPED',
      newState: 'STOPPED',
      transitionOccurred: false,
      reason: 'no_movement',
      actions: { ...baseActions },
      updatedState: {
        deviceId: '869131070495653',
        currentStopId: 'stop_parada_en_curso',
        currentTripId: undefined,
        lastTimestamp: 1_000_000,
      },
    });

    await service.processPosition(pos());

    expect(stopRepository.touchStop).toHaveBeenCalledWith('stop_parada_en_curso');
  });

  it('NO llama touchStop si no hay parada activa', async () => {
    stateMachine.processPosition.mockReturnValue({
      previousState: 'MOVING',
      newState: 'MOVING',
      transitionOccurred: false,
      reason: 'moving',
      actions: { ...baseActions },
      updatedState: {
        deviceId: '869131070495653',
        currentStopId: undefined,
        currentTripId: 'trip_1',
        lastTimestamp: 1_000_000,
      },
    });

    await service.processPosition(pos({ speed: 40, ignition: true }));

    expect(stopRepository.touchStop).not.toHaveBeenCalled();
  });
});
