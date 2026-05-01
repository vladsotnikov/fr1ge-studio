#!/bin/zsh
cd /Users/vfr1ge/Documents/VoiceStockStudio
export HOST=127.0.0.1
export PORT=3333
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export FFMPEG_BIN=/opt/homebrew/bin/ffmpeg
export FFPROBE_BIN=/opt/homebrew/bin/ffprobe
exec /opt/homebrew/bin/node /Users/vfr1ge/Documents/VoiceStockStudio/server.js
