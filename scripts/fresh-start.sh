#!/bin/bash
# ==========================================
# Fresh Start Script for Tripero
# ==========================================
# This script tears down everything and starts from scratch
# Useful for testing deployment and database initialization

set -e  # Exit on error

echo "🔥 TRIPERO - Fresh Start Script"
echo "================================"
echo ""
echo "⚠️  WARNING: This will delete ALL data (volumes, containers, etc.)"
echo ""
read -p "Are you sure you want to continue? (yes/no): " -r
if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "Aborted."
    exit 1
fi

echo ""
echo "📋 Step 1: Stopping and removing containers..."
docker-compose down -v 2>/dev/null || echo "No containers to stop"

echo ""
echo "🗑️  Step 2: Removing volumes..."
docker volume rm tripero_timescaledb-data 2>/dev/null || echo "Volume tripero_timescaledb-data not found"
docker volume rm tripero_redis-data 2>/dev/null || echo "Volume tripero_redis-data not found"

echo ""
echo "🚀 Step 3: Starting services..."
docker-compose up -d

echo ""
echo "⏳ Step 4: Waiting for TimescaleDB to be ready..."
echo "   (This may take 30-60 seconds for first-time initialization)"
RETRY_COUNT=0
MAX_RETRIES=60

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if docker-compose exec -T timescaledb pg_isready -U postgres -q; then
        echo "   ✅ TimescaleDB is ready!"
        break
    fi
    echo -n "."
    sleep 1
    RETRY_COUNT=$((RETRY_COUNT + 1))
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo ""
    echo "   ❌ TimescaleDB failed to start within timeout"
    exit 1
fi

echo ""
echo "⏳ Step 5: Waiting for Redis to be ready..."
RETRY_COUNT=0
while [ $RETRY_COUNT -lt 30 ]; do
    if docker-compose exec -T redis redis-cli ping | grep -q PONG; then
        echo "   ✅ Redis is ready!"
        break
    fi
    echo -n "."
    sleep 1
    RETRY_COUNT=$((RETRY_COUNT + 1))
done

if [ $RETRY_COUNT -eq 30 ]; then
    echo ""
    echo "   ❌ Redis failed to start within timeout"
    exit 1
fi

echo ""
echo "🔍 Step 6: Verifying database initialization..."
echo "   Checking if tables were created by init-db.sql..."

TABLES=$(docker-compose exec -T timescaledb psql -U postgres -d tripero -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('trips', 'stops', 'tracker_state');")

if [ "$TABLES" -eq "3" ]; then
    echo "   ✅ All tables created successfully!"
else
    echo "   ❌ Tables not found! Expected 3, got $TABLES"
    echo "   Database initialization may have failed."
    exit 1
fi

echo ""
echo "🔍 Step 7: Verifying TimescaleDB hypertables..."
HYPERTABLES=$(docker-compose exec -T timescaledb psql -U postgres -d tripero -tAc "SELECT COUNT(*) FROM timescaledb_information.hypertables WHERE hypertable_name IN ('trips', 'stops');")

if [ "$HYPERTABLES" -eq "2" ]; then
    echo "   ✅ Hypertables configured successfully!"
else
    echo "   ⚠️  Warning: Hypertables not found! Expected 2, got $HYPERTABLES"
fi

echo ""
echo "📊 Step 8: Database status:"
docker-compose exec -T timescaledb psql -U postgres -d tripero -c "\dt"

echo ""
echo "✅ Fresh start completed successfully!"
echo ""
echo "📝 Next steps:"
echo "   1. Copy .env.example to .env and configure your settings"
echo "   2. Start the Tripero application:"
echo "      npm install"
echo "      npm run start:dev"
echo "   3. Test with: curl http://localhost:3001/health"
echo "   4. Run simulation: node test/simulate-trip.js"
echo ""
echo "📚 View logs:"
echo "   docker-compose logs -f timescaledb"
echo "   docker-compose logs -f redis"
echo ""
