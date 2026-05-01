#!/usr/bin/env python3
"""
Автоматический монтаж видео v2: Пропорциональный маппинг
Синхронизирует видеоклипы с озвучкой.
Длительность каждого клипа пропорциональна количеству слов в его тексте.
Общая длительность видеоряда = длительность аудио.
"""

import json
import sys
import os
import subprocess
import shutil
import argparse
from pathlib import Path


def log(msg):
    print(f"[МОНТАЖ] {msg}", flush=True)


def check_dependencies():
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        log("✓ ffmpeg найден")
    except (subprocess.CalledProcessError, FileNotFoundError):
        log("✗ ffmpeg не найден. Установите: brew install ffmpeg")
        sys.exit(1)


def get_audio_duration(audio_path):
    """Получить длительность аудиофайла через ffprobe"""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        str(audio_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    info = json.loads(result.stdout)
    return float(info["format"]["duration"])


def compute_proportional_timings(scenes, total_duration):
    """
    Пропорциональное распределение: длительность каждой сцены
    пропорциональна количеству слов в её тексте.
    Сумма всех длительностей = total_duration.
    """
    import re

    # Считаем слова в каждой сцене
    word_counts = []
    for scene in scenes:
        words = re.findall(r"[a-zA-Z0-9']+", scene["text"])
        word_counts.append(max(len(words), 1))  # минимум 1 слово

    total_words = sum(word_counts)
    log(f"Всего слов: {total_words}, длительность аудио: {total_duration:.1f}s")

    # Распределяем время пропорционально словам
    timings = []
    current_time = 0.0

    for si, scene in enumerate(scenes):
        proportion = word_counts[si] / total_words
        duration = proportion * total_duration

        # Минимум 2 секунды, максимум 20 секунд
        duration = max(2.0, min(duration, 20.0))

        timings.append({
            "start": current_time,
            "end": current_time + duration,
            "duration": duration,
            "words": word_counts[si],
        })

        current_time += duration

    # Корректируем — нормализуем сумму до total_duration
    actual_total = sum(t["duration"] for t in timings)
    scale = total_duration / actual_total

    current_time = 0.0
    for t in timings:
        t["duration"] *= scale
        t["start"] = current_time
        t["end"] = current_time + t["duration"]
        current_time += t["duration"]

    # Последний клип заканчивается ровно в конце аудио
    timings[-1]["end"] = total_duration
    timings[-1]["duration"] = total_duration - timings[-1]["start"]

    return timings


def get_video_duration(video_path):
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        str(video_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    info = json.loads(result.stdout)
    return float(info["format"]["duration"])


def trim_or_loop_clip(input_path, output_path, target_duration):
    actual_duration = max(target_duration, 2.0)
    clip_duration = get_video_duration(input_path)

    if actual_duration <= clip_duration:
        cmd = [
            "ffmpeg", "-y", "-i", str(input_path),
            "-t", str(actual_duration),
            "-c:v", "libx264", "-preset", "fast",
            "-an",
            "-loglevel", "warning",
            str(output_path),
        ]
        subprocess.run(cmd, check=True)
    else:
        loops_needed = int(actual_duration / clip_duration) + 1
        concat_file = str(output_path) + ".concat.txt"
        with open(concat_file, "w") as f:
            for _ in range(loops_needed):
                f.write(f"file '{os.path.abspath(input_path)}'\n")

        cmd = [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", concat_file,
            "-t", str(actual_duration),
            "-c:v", "libx264", "-preset", "fast",
            "-an",
            "-loglevel", "warning",
            str(output_path),
        ]
        subprocess.run(cmd, check=True)
        os.remove(concat_file)

    return actual_duration


def concatenate_clips(clip_paths, output_path, resolution="1280x720"):
    w, h = resolution.split("x")

    concat_file = str(output_path) + ".concat.txt"
    with open(concat_file, "w") as f:
        for clip in clip_paths:
            f.write(f"file '{os.path.abspath(clip)}'\n")

    cmd = [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", concat_file,
        "-vf", f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black",
        "-r", "30",
        "-c:v", "libx264", "-preset", "fast",
        "-pix_fmt", "yuv420p",
        "-an",
        "-loglevel", "warning",
        str(output_path),
    ]
    subprocess.run(cmd, check=True)
    os.remove(concat_file)


def merge_audio_video(video_path, audio_path, output_path):
    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-i", str(audio_path),
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k",
        "-map", "0:v:0", "-map", "1:a:0",
        "-loglevel", "warning",
        str(output_path),
    ]
    subprocess.run(cmd, check=True)


def main():
    parser = argparse.ArgumentParser(description="Автоматический монтаж видео v2")
    parser.add_argument("project", help="Путь к project.json")
    args = parser.parse_args()

    project_path = Path(args.project)
    if not project_path.exists():
        log(f"✗ Файл не найден: {project_path}")
        sys.exit(1)

    with open(project_path) as f:
        project = json.load(f)

    base_dir = project_path.parent
    temp_dir = base_dir / "temp"
    output_dir = base_dir / "output"

    temp_dir.mkdir(exist_ok=True)
    output_dir.mkdir(exist_ok=True)

    log("=" * 50)
    log("АВТОМАТИЧЕСКИЙ МОНТАЖ ВИДЕО v2")
    log("Пропорциональный маппинг по словам")
    log("=" * 50)

    check_dependencies()

    audio_path = base_dir / project["audio_file"]
    if not audio_path.exists():
        log(f"✗ Озвучка не найдена: {audio_path}")
        sys.exit(1)

    resolution = project.get("resolution", "1280x720")
    clips_dir = base_dir / project.get("clips_dir", "input/clips")
    scenes = project["scenes"]
    log(f"Проект: {len(scenes)} сцен, разрешение {resolution}")
    log(f"Клипы: {clips_dir}")

    # ШАГ 1: Определяем длительность аудио
    log("\n--- ШАГ 1: Анализ аудио ---")
    total_duration = get_audio_duration(audio_path)
    log(f"Длительность озвучки: {total_duration:.1f}s ({total_duration/60:.1f} мин)")

    # ШАГ 2: Пропорциональный маппинг
    log(f"\n--- ШАГ 2: Пропорциональный маппинг {len(scenes)} сцен ---")
    timings = compute_proportional_timings(scenes, total_duration)

    for scene, timing in zip(scenes, timings):
        log(f"  ✓ Сцена {scene['id']:3d}: {timing['start']:7.2f}s — {timing['end']:7.2f}s "
            f"({timing['duration']:5.2f}s, {timing['words']} слов)")

    total_video = sum(t["duration"] for t in timings)
    log(f"\nОбщая длительность видеоряда: {total_video:.1f}s (аудио: {total_duration:.1f}s)")

    # ШАГ 3: Подготовка клипов
    log(f"\n--- ШАГ 3: Подготовка {len(scenes)} клипов ---")

    trimmed_clips = []
    for i, (scene, timing) in enumerate(zip(scenes, timings)):
        clip_path = clips_dir / scene["clip"]
        if not clip_path.exists():
            log(f"  ⚠ Клип не найден: {clip_path}")
            continue

        out_clip = temp_dir / f"trimmed_{scene['id']:03d}.mp4"
        log(f"  [{i+1}/{len(scenes)}] Сцена {scene['id']}: {timing['duration']:.2f}s")

        trim_or_loop_clip(clip_path, out_clip, timing["duration"])
        trimmed_clips.append(str(out_clip))

    if not trimmed_clips:
        log("✗ Нет подготовленных клипов")
        sys.exit(1)

    # ШАГ 4: Склейка
    log(f"\n--- ШАГ 4: Склейка {len(trimmed_clips)} клипов ---")

    video_only = temp_dir / "video_concat.mp4"
    concatenate_clips(trimmed_clips, video_only, resolution)
    log(f"✓ Видеоряд: {video_only}")

    video_duration = get_video_duration(video_only)
    log(f"Длительность видеоряда: {video_duration:.1f}s")

    # ШАГ 5: Наложение озвучки
    log("\n--- ШАГ 5: Наложение озвучки ---")

    final_output = base_dir / project.get("output_file", "output/final_video.mp4")
    merge_audio_video(video_only, audio_path, final_output)

    final_duration = get_video_duration(final_output)
    log(f"\n{'=' * 50}")
    log(f"ГОТОВО! Длительность: {final_duration:.1f}s ({final_duration/60:.1f} мин)")
    log(f"Файл: {final_output}")
    log(f"{'=' * 50}")

    # Очистка
    log("\nОчистка временных файлов...")
    shutil.rmtree(temp_dir)
    log("✓ Готово!")


if __name__ == "__main__":
    main()
