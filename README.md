# Tripero

**GPS Trip Detection and Stop Analysis Microservice**

Servicio opensource de detección inteligente de viajes y paradas para sistemas de rastreo GPS.

## Arquitectura

Este servicio implementa una arquitectura de microservicios con su propia base de datos independiente. Ver [ARQUITECTURA.md](./ARQUITECTURA.md) para más detalles sobre las decisiones arquitectónicas.

### Dependencias Externas

- **TimescaleDB**: Base de datos time-series (PostgreSQL + extensión TimescaleDB)
- **Redis**: Cache y PubSub para estado en tiempo real

## Setup Local

### Prerrequisitos

- Node.js 20+
- Docker y Docker Compose

### Instalación

1. Clonar el repositorio y navegar al directorio:
```bash
cd tripero
```

2. Instalar dependencias:
```bash
npm install
```

3. Copiar el archivo de configuración:
```bash
cp .env.example .env
```

4. Iniciar servicios de infraestructura (TimescaleDB y Redis):
```bash
docker-compose up -d
```

5. Esperar a que TimescaleDB esté listo (verificar con logs):
```bash
docker-compose logs -f timescaledb
```

6. En modo desarrollo con DB_SYNCHRONIZE=true, las tablas se crearán automáticamente. Luego, conectarse a la base de datos para crear las hypertables:

```bash
docker exec -it tripero-timescaledb psql -U postgres -d tripero
```

Ejecutar los siguientes comandos SQL:
```sql
SELECT create_hypertable('trips', 'start_time', if_not_exists => TRUE);
SELECT create_hypertable('stops', 'start_time', if_not_exists => TRUE);

-- Opcional: Configurar compresión automática
ALTER TABLE trips SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'id_activo',
  timescaledb.compress_orderby = 'start_time DESC'
);

ALTER TABLE stops SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'id_activo',
  timescaledb.compress_orderby = 'start_time DESC'
);

-- Política de compresión: comprimir datos más viejos de 7 días
SELECT add_compression_policy('trips', INTERVAL '7 days');
SELECT add_compression_policy('stops', INTERVAL '7 days');
```

7. Iniciar el servicio en modo desarrollo:
```bash
npm run start:dev
```

### Verificar Health Check

```bash
curl http://localhost:3000/health
```

Debería retornar un JSON indicando el estado de Redis, TimescaleDB y API Datos.

## Variables de Entorno

Ver `.env.example` para todas las variables disponibles. Las principales son:

- `PORT`: Puerto del servicio (default: 3000)
- `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE`: Configuración de TimescaleDB
- `REDIS_HOST`, `REDIS_PORT`: Configuración de Redis
- `DB_SYNCHRONIZE`: Solo usar `true` en desarrollo (crea tablas automáticamente)

## Desarrollo

### Estructura del Proyecto

```
src/
├── auxiliares/        # Servicios auxiliares (Redis, HTTP, Logger)
├── database/          # Entities, repositories y módulo de BD
│   ├── entities/      # Entidades TypeORM
│   └── repositories/  # Repositorios con lógica de acceso a datos
├── health/            # Health checks para Kubernetes
├── app.module.ts      # Módulo principal
└── main.ts            # Bootstrap de la aplicación
```

### Scripts

- `npm run start:dev` - Modo desarrollo con hot reload
- `npm run build` - Build de producción
- `npm run start:prod` - Ejecutar build de producción
- `npm run lint` - Linter

## Deployment

### Docker

Construir imagen:
```bash
docker build -t tripero:latest .
```

### Kubernetes

Ver manifiestos en el directorio de deployment del cluster.

## Monitoreo

- Health check: `GET /health`
- Readiness probe: `GET /health/ready`

## Estado del Proyecto

**Versión actual**: 0.1.0 (Fase 0 completada)

Ver [TODO.md](./TODO.md) para la hoja de ruta completa del proyecto y próximas fases.

## Referencias

- [TESTING.md](./TESTING.md) - **Guía de testing y pruebas locales**
- [INTEGRACION.md](./INTEGRACION.md) - **Guía de integración con sistemas externos**
- [TODO.md](./TODO.md) - Hoja de ruta y tareas pendientes
- [ARQUITECTURA.md](./ARQUITECTURA.md) - Decisiones arquitectónicas (ADRs)
- [PLAN-IMPLEMENTACION-TRIP-DETECTION.md](./PLAN-IMPLEMENTACION-TRIP-DETECTION.md) - Plan de implementación completo
- [ANALISIS-TRIPS-TRACCAR.md](./ANALISIS-TRIPS-TRACCAR.md) - Análisis del sistema anterior

## Contribuir

Las contribuciones son bienvenidas! Por favor:

1. Fork el proyecto
2. Crea un feature branch (`git checkout -b feature/amazing-feature`)
3. Commit tus cambios (`git commit -m 'Add amazing feature'`)
4. Push al branch (`git push origin feature/amazing-feature`)
5. Abre un Pull Request

Ver [TODO.md](./TODO.md) para ideas de contribuciones.

## Licencia

MIT License - ver [LICENSE](./LICENSE) para más detalles.

Copyright (c) 2024 GPE Sistemas
