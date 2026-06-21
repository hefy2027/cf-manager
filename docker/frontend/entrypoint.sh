#!/bin/sh
set -e

# Default BASE_URL to / if not set
BASE_URL="${BASE_URL:-/}"

# Ensure BASE_URL ends with /
case "$BASE_URL" in
  */) ;;
  *) BASE_URL="${BASE_URL}/" ;;
esac

export BASE_URL

# Generate nginx config from template, only replacing $BASE_URL (preserve nginx variables)
envsubst '${BASE_URL}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
