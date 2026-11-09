#!/bin/sh
set -eu
TASK_MAP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TASK_HELPER="$TASK_MAP_ROOT/native-helper/Understanding Map Navigator.app/Contents/MacOS/MapNavigator"
if [ ! -x "$TASK_HELPER" ]; then
  sh "$TASK_MAP_ROOT/native-helper/build_helper.sh"
fi
printf '%s\n' 'Understanding Map 本机定位实验版'
printf '%s\n' '请先手动打开 native-helper/Understanding Map Navigator.app，并在系统设置中授予辅助功能权限。'
printf '%s\n' '本服务由你点击地图节点触发，不调用模型。按 Ctrl+C 可停止。'
printf '%s\n' '若 18766 端口被占用，请先关闭旧地图预览服务后重试。'
python3 "$TASK_MAP_ROOT/preview_server.py" \
  --config "$TASK_MAP_ROOT/../understanding-map-private/tracking.json" \
  --native-helper "$TASK_HELPER"
