#!/usr/bin/env sh
# Wraps luna.html (the page body, also used as the hosted preview) into a standalone index.html.
set -e
cd "$(dirname "$0")"
{
  printf '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  sed -n '1,/^<\/style>$/p' luna.html
  printf '</head>\n<body>\n'
  sed -n '/^<\/style>$/,$p' luna.html | tail -n +2
  printf '</body>\n</html>\n'
} > index.html
echo "index.html written"
