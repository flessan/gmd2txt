#!/usr/bin/env python3
"""Generate PixelSky.wav — the workspace's original 8-bit menu/fallback theme.

A calm, seamless chiptune loop (square lead, triangle bass, arpeggio, soft
noise hats) in the spirit of an 8-bit overworld. Everything is synthesized
here from first principles, so the track is original and license-clean.

Usage:  python3 tools/generate-pixel-sky-music.py [outfile.wav]
"""

import math
import struct
import sys
import wave

SAMPLE_RATE = 22050
BPM = 116
BEAT = 60.0 / BPM          # seconds per beat
BARS = 8                   # 8 bars of 4/4 -> 32 beats -> ~16.5 s seamless loop
LOOP_SECONDS = BARS * 4 * BEAT
N = int(round(LOOP_SECONDS * SAMPLE_RATE))

# ---------------------------------------------------------------- notes ---
NAMES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def freq(name):
    """'E4' / 'C#3' -> frequency in Hz."""
    letter, octave = name[0], int(name[-1])
    sharp = 1 if "#" in name else 0
    semitone = NAMES[letter] + sharp
    midi = 12 * (octave + 1) + semitone
    return 440.0 * (2 ** ((midi - 69) / 12.0))


# ------------------------------------------------------------- envelopes --


def env(t, dur, attack=0.01, release=0.08):
    if t < 0 or t > dur:
        return 0.0
    if t < attack:
        return t / attack
    if t > dur - release:
        return max(0.0, (dur - t) / release)
    return 1.0


# ------------------------------------------------------------ oscillators --


def square(t, f, duty=0.5):
    return 1.0 if (t * f) % 1.0 < duty else -1.0


def triangle(t, f):
    p = (t * f) % 1.0
    return 4.0 * abs(p - 0.5) - 1.0


_noise_state = 0x2545F491


def noise():
    global _noise_state
    _noise_state ^= (_noise_state << 13) & 0xFFFFFFFF
    _noise_state ^= (_noise_state >> 17) & 0xFFFFFFFF
    _noise_state ^= (_noise_state << 5) & 0xFFFFFFFF
    return ((_noise_state & 0xFFFF) / 32768.0) - 1.0


# --------------------------------------------------------------- mixing ---
buffer = [0.0] * N


def add_note(start_beat, length_beats, note, wave_fn, volume, attack=0.01,
             release=0.12, duty=None, vibrato=0.0):
    """Mix one note into the loop, wrapping any tail around the seam."""
    f = freq(note) if isinstance(note, str) else float(note)
    t0 = start_beat * BEAT
    dur = length_beats * BEAT
    n_samples = int(dur * SAMPLE_RATE)
    start = int(t0 * SAMPLE_RATE)
    for i in range(n_samples):
        t = i / SAMPLE_RATE
        if wave_fn is square:
            value = square(t, f, duty if duty is not None else 0.5)
        elif wave_fn is triangle:
            value = triangle(t, f)
        else:
            value = wave_fn(t, f)
        if vibrato:
            value = square(t, f * (1.0 + vibrato * math.sin(2 * math.pi * 5.5 * t)),
                           duty if duty is not None else 0.25)
        value *= env(t, dur, attack, release) * volume
        index = (start + i) % N
        buffer[index] += value


def add_hat(start_beat, volume=0.10):
    start = int(start_beat * BEAT * SAMPLE_RATE)
    length = int(0.06 * SAMPLE_RATE)
    for i in range(length):
        value = noise() * (1.0 - i / length) ** 2 * volume
        buffer[(start + i) % N] += value


def add_kick(start_beat, volume=0.28):
    start = int(start_beat * BEAT * SAMPLE_RATE)
    length = int(0.10 * SAMPLE_RATE)
    for i in range(length):
        t = i / SAMPLE_RATE
        f = 120.0 * (1.0 - t * 4.0)
        value = math.sin(2 * math.pi * max(30.0, f) * t) * (1.0 - t / 0.10) * volume
        buffer[(start + i) % N] += value


# ------------------------------------------------------------ the song ----
# Key: C major / A minor pentatonic. 8-bar loop with a gentle A-B-A shape.

BASS_A = ["C2", "C2", "G2", "G2", "A2", "A2", "F2", "F2"]
BASS_B = ["F2", "F2", "C2", "C2", "G2", "G2", "G2", "G2"]

# One root per bar (2 beats each half-bar handled below).
for bar in range(BARS):
    seq = BASS_A if bar % 4 in (0, 1) else BASS_B
    root = seq[bar % len(seq)]
    base = bar * 4
    add_note(base, 1.8, root, triangle, 0.34, attack=0.01, release=0.18)
    add_note(base + 2, 1.8, root, triangle, 0.28, attack=0.01, release=0.18)
    # gentle off-beat pulse
    add_note(base + 1.5, 0.4, root, square, 0.06, duty=0.12, release=0.05)
    add_note(base + 3.5, 0.4, root, square, 0.06, duty=0.12, release=0.05)

# Lead melody — two four-bar phrases, answered by the second.
PHRASE_1 = [
    (0.0, 1.0, "E4"), (1.0, 0.5, "G4"), (1.5, 0.5, "A4"), (2.0, 1.5, "G4"),
    (3.5, 0.5, "E4"),
    (4.0, 1.0, "D4"), (5.0, 0.5, "E4"), (5.5, 1.0, "G4"), (6.5, 1.5, "E4"),
    (8.0, 1.0, "C4"), (9.0, 0.5, "D4"), (9.5, 0.5, "E4"), (10.0, 2.0, "D4"),
    (12.0, 1.0, "A3"), (13.0, 0.5, "C4"), (13.5, 2.0, "C4"),
]
PHRASE_2 = [
    (0.0, 1.0, "G4"), (1.0, 0.5, "A4"), (1.5, 0.5, "C5"), (2.0, 1.5, "A4"),
    (3.5, 0.5, "G4"),
    (4.0, 1.0, "E4"), (5.0, 0.5, "G4"), (5.5, 1.0, "A4"), (6.5, 1.5, "G4"),
    (8.0, 1.0, "E4"), (9.0, 0.5, "D4"), (9.5, 0.5, "E4"), (10.0, 2.0, "G4"),
    (12.0, 1.5, "A4"), (13.5, 0.5, "G4"), (14.0, 2.0, "E4"),
]

for start, length, note in PHRASE_1:
    add_note(start, length, note, square, 0.20, duty=0.25, attack=0.015,
             release=0.14, vibrato=0.006)
for start, length, note in PHRASE_2:
    add_note(16 + start, length, note, square, 0.20, duty=0.25, attack=0.015,
             release=0.14, vibrato=0.006)

# Sparkle arpeggio — quiet eighths that chase the chord.
ARP = ["C5", "E5", "G5", "E5"]
for step in range(int(LOOP_SECONDS / BEAT / 0.5)):
    note = ARP[step % len(ARP)]
    add_note(step * 0.5, 0.45, note, square, 0.045, duty=0.12, release=0.08)

# Soft rhythm: kick on 1 & 3, hat on the off-beats.
for bar in range(BARS):
    base = bar * 4
    add_kick(base, 0.26)
    add_kick(base + 2, 0.20)
    for half in (1, 3):
        add_hat(base + half, 0.085)

# ---------------------------------------------------------------- output --
peak = max(abs(v) for v in buffer) or 1.0
scale = 0.72 / peak
out = sys.argv[1] if len(sys.argv) > 1 else \
    "app/play/assets/music/PixelSky.wav"

with wave.open(out, "w") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(SAMPLE_RATE)
    frames = bytearray()
    for value in buffer:
        sample = value * scale
        sample = math.tanh(sample * 1.25)  # gentle soft-clip
        frames += struct.pack("<h", int(max(-1.0, min(1.0, sample)) * 32767))
    wav.writeframes(bytes(frames))

print(f"wrote {out}: {N} samples, {LOOP_SECONDS:.2f}s loop")
