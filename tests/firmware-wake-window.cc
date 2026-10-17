#include "wake_word_speech_window.h"

#include <cassert>
#include <iostream>
#include <limits>

int main() {
    WakeWordSpeechWindow window;
    assert(!window.Observe(true, 0));
    assert(window.Observe(true, 512));
    for (int i = 0; i < 100; ++i) assert(!window.Observe(true, 512));
    // A pause between syllables must not erase the decoder prefix.
    for (int i = 0; i < 14; ++i) assert(!window.Observe(false, 512));
    assert(!window.Observe(true, 512));
    for (int i = 0; i < 15; ++i) assert(!window.Observe(false, 512));
    assert(window.Observe(true, 512));
    assert(!window.Observe(false, std::numeric_limits<size_t>::max()));
    assert(window.Observe(true, 512));

    std::vector<int16_t> samples(7000);
    for (size_t i = 0; i < samples.size(); ++i) samples[i] = static_cast<int16_t>(i);
    window.Remember(samples.data(), 123);
    std::vector<int16_t> prefix;
    window.CopyPreroll(prefix);
    assert(prefix == std::vector<int16_t>(samples.begin(), samples.begin() + 123));
    window.Remember(samples.data() + 123, samples.size() - 123);
    window.CopyPreroll(prefix);
    assert(prefix == std::vector<int16_t>(samples.end() - window.kPrerollSamples, samples.end()));
    // Restarting listening discards the previous utterance and rearms onset.
    window.Reset();
    window.CopyPreroll(prefix);
    assert(prefix.empty());
    assert(window.Observe(true, 512));
    std::cout << "Wake window: onset, pause hysteresis, saturation, preroll order and restart passed\n";
}
