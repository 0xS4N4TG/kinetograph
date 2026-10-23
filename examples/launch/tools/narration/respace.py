# Lengthens the pauses of one take at sentence ends: cuts in the middle of the silent gap after a word and
# inserts silence there. Words are never cut or moved relative to each other inside a sentence.
#   python3 tools/narration/respace.py <asr.json> <take.wav (16-bit mono)> <out.wav> [<out asr.json>]
# The optional last argument writes the take's ASR words with their times moved by the added silence (exact, so the
# spaced take needs no second ASR, which hallucinates words into long silences).
import array, json, sys, wave

asr_path, src, out = sys.argv[1:4]
asr = json.load(open(asr_path))
key = next(k for k in asr if k.endswith('/' + src.split('/')[-1]))
words = asr[key]['words']

# Pauses by the index of the word they follow (the ASR's punctuation drifts, so words are found by position: the
# take is the script's 91 ASR tokens, the same split tools/narration/lines.mjs uses), with seconds of silence to add.
PAUSES = {
    6: 0.5,    # move.
    18: 0.4,   # frame.
    22: 0.3,   # one.
    28: 0.6,   # GPU.
    34: 0.2,   # changelog.
    41: 1.2,   # renders.  (the receipts)
    45: 0.5,   # text.     ("3D isometric" runs together in the take, so no pause there)
    49: 0.5,   # scenes.
    50: 0.7,   # Shaders.
    51: 0.7,   # Canvas.
    57: 0.6,   # light.
    66: 0.5,   # replacement.
    73: 0.6,   # seconds.
    79: 1.6,   # pixels.   (shot 11's flicker)
    80: 0.3,   # Kinetograph.
}
if len(words) != 91:
    sys.exit(f'expected 91 words, got {len(words)}: ' + ' '.join(w['w'] for w in words))
r = wave.open(src)
assert r.getnchannels() == 1 and r.getsampwidth() == 2, 'expects 16-bit mono'
rate = r.getframerate()
pcm = r.readframes(r.getnframes())
smp = array.array('h', pcm)

def quietest(a, b):
    # the sample at the centre of the quietest 10 ms in [a, b] seconds, so the cut lands in silence, not on a breath
    win = int(0.01 * rate)
    lo, hi = int(a * rate), max(int(a * rate) + 1, int(b * rate) - win)
    best = min(range(lo, hi, max(1, win // 4)), key=lambda k: sum(abs(v) for v in smp[k:k + win]))
    return best + win // 2

cuts = []
for i, add in PAUSES.items():
    e, s_ = words[i]['e'], words[i + 1]['s']
    k = quietest(e - 0.02, max(s_, e + 0.03))  # stay out of the next word
    cuts.append((k, add))
    print(f'  after {words[i]["w"]!r}: gap {s_ - e:.2f} s, cut at {k / rate:.3f} s, level {max(abs(v) for v in smp[k - 48:k + 48])}')
cuts.sort()
# a 6 ms fade either side of each cut, so a cut in a breath or a run-on word doesn't click
fade = int(0.006 * rate)
for k, _ in cuts:
    for j in range(fade):
        g = j / fade
        smp[k - 1 - j] = int(smp[k - 1 - j] * g)
        smp[k + j] = int(smp[k + j] * g)
pcm = smp.tobytes()
w = wave.open(out, 'wb')
w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
at = 0
for k, add in cuts:
    s = k * 2
    w.writeframes(pcm[at:s]); w.writeframes(b'\0\0' * int(add * rate))
    at = s
w.writeframes(pcm[at:])
w_dur = (len(pcm) // 2 + sum(int(a * rate) for _, a in cuts)) / rate
w.close()
print(f'{len(cuts)} pauses, +{sum(a for _, a in cuts):.1f} s -> {out}')

if len(sys.argv) > 4:
    # word j moves by the silence added after every word before it (by index: the ASR's times are too rough to
    # say which side of a cut a word starts on)
    add = lambda j: sum(a for i, a in PAUSES.items() if i < j)
    moved = [{**x, 's': round(x['s'] + add(j), 3), 'e': round(x['e'] + add(j), 3)} for j, x in enumerate(words)]
    name = out.split('/')[-1]
    json.dump({'voice/takes/' + name: {**asr[key], 'words': moved, 'dur': w_dur}}, open(sys.argv[4], 'w'))
    print('words ->', sys.argv[4])
