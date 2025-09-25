#!/bin/bash

# Cloudflare API Token
export CLOUDFLARE_API_TOKEN="68zRjevjC8ci_D00euNvAIcSfZ5dUbijj_tdwAWt"

echo "=== Cloudflare Pages Deployment Script ==="
echo "Project: care-progress-summary"
echo ""

# Step 1: Build the project
echo "Step 1: Building project..."
npm run build
if [ $? -ne 0 ]; then
    echo "Build failed!"
    exit 1
fi

echo "Build completed successfully!"
echo ""

# Step 2: Create Cloudflare Pages project
echo "Step 2: Creating Cloudflare Pages project..."
npx wrangler pages project create care-progress-summary \
  --production-branch main \
  --compatibility-date 2024-01-01 2>/dev/null || true

echo ""

# Step 3: Deploy to Cloudflare Pages
echo "Step 3: Deploying to Cloudflare Pages..."
npx wrangler pages deploy dist \
  --project-name care-progress-summary \
  --branch main

if [ $? -eq 0 ]; then
    echo ""
    echo "=== Deployment Successful! ==="
    echo "Your app is now live at:"
    echo "https://care-progress-summary.pages.dev"
    echo ""
    
    # Step 4: Set environment variables
    echo "Step 4: Setting environment variables..."
    
    # DeepSeek API Key
    echo "sk-e324780129514a8d8bcd040cdd3809a3" | npx wrangler pages secret put OPENAI_API_KEY \
      --project-name care-progress-summary
    
    # Basic Auth credentials
    echo "admin" | npx wrangler pages secret put BASIC_USER \
      --project-name care-progress-summary
      
    echo "care2024" | npx wrangler pages secret put BASIC_PASS \
      --project-name care-progress-summary
    
    echo ""
    echo "Environment variables set successfully!"
    echo ""
    echo "=== Deployment Complete! ==="
    echo "URL: https://care-progress-summary.pages.dev"
    echo "Username: admin"
    echo "Password: care2024"
else
    echo "Deployment failed!"
    exit 1
fi