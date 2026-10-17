#include "audio_level_meter.h"
#include <cassert>
#include <cmath>
#include <cstdio>

int main() {
  AudioLevelMeter mic, reference;
  assert(mic.Rms() == 0 && mic.Peak() == 0);
  const int16_t stereo[] = {300, 30000, -300, -30000, 300, 30000, -300, -30000};
  mic.Add(stereo, 8, 2, 0);
  reference.Add(stereo, 8, 2, 1);
  assert(mic.Samples() == 4 && mic.Peak() == 300 && mic.Rms() == 300);
  assert(reference.Samples() == 4 && reference.Rms() == 30000);
  mic.Reset();
  assert(mic.Samples() == 0 && mic.Peak() == 0 && mic.Rms() == 0);
  const int16_t extremes[] = {INT16_MIN, INT16_MAX};
  for (int i = 0; i < 10000; ++i)
    mic.Add(extremes, 2);
  assert(mic.Samples() == 20000 && mic.Peak() == 32768 &&
         mic.RailSamples() == 20000);
  assert(std::abs(mic.Rms() - 32767.5f) < 0.1f);
  // Quiet windows and invalid input must not carry stale speech levels.
  mic.Reset();
  const int16_t silence[] = {0, 0, 0, 0};
  mic.Add(silence, 4);
  mic.Add(nullptr, 4);
  mic.Add(stereo, 8, 0);
  mic.Add(stereo, 8, 2, 2);
  assert(mic.Samples() == 4 && mic.Rms() == 0 && mic.RailSamples() == 0);
  std::puts("Audio level checks passed: channel separation, full-scale "
            "overflow, reset and silence.");
}
