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
docker volume rm tripero_postgres-data 2>/dev/null || echo "Volume tripero_postgres-data not found"
docker volume rm tripero_redis-data 2>/dev/null || echo "Volume tripero_redis-data not found"

echo ""
echo "🚀 Step 3: Starting services..."
docker-compose up -d

echo ""
echo "⏳ Step 4: Waiting for PostgreSQL to be ready..."
echo "   (This may take 10-20 seconds)"
RETRY_COUNT=0
MAX_RETRIES=30

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if docker-compose exec -T postgres pg_isready -U postgres -q; then
        echo "   ✅ PostgreSQL is ready!"
        break
    fi
    echo -n "."
    sleep 1
    RETRY_COUNT=$((RETRY_COUNT + 1))
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo ""
    echo "   ❌ PostgreSQL failed to start within timeout"
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
echo "📊 Step 6: Database status (before Tripero starts):"
echo "   Database is empty - TypeORM will create tables on first run"
docker-compose exec -T postgres psql -U postgres -d tripero -c "\dt" || echo "   No tables yet (expected)"

echo ""
echo "✅ Fresh start completed successfully!"
echo ""
echo "📝 Next steps:"
echo "   1. Copy .env.example to .env and configure your settings"
echo "   2. Start the Tripero application:"
echo "      npm install"
echo "      npm run start:dev"
echo "   3. TypeORM will automatically create tables on startup"
echo "   4. Test with: curl http://localhost:3001/health"
echo "   5. Run simulation: node test/simulate-trip.js"
echo ""
echo "📚 View logs:"
echo "   docker-compose logs -f postgres"
echo "   docker-compose logs -f redis"
echo ""
echo "🔍 Verify tables were created after starting Tripero:"
echo "   docker-compose exec postgres psql -U postgres -d tripero -c \"\\dt\""
echo ""
