// End-to-end fixture for media inside a timed <Sequence>. Two compositions, 30 fps, 160x90:
//   RateTrim: <Sequence from={15} trimBefore={10} playbackRate={2}> around an <Audio> and a <Video>.
//   Loop:     <Sequence durationInFrames={30} loop> around the same two.
// assets/click.wav has a 1 kHz click at every 20th frame (0, 20, 40 ...) of a 120-frame file; assets/gray.mp4 is 120
// frames whose grey level is 2 * frame index. Make them with ./make-assets.sh; check.mjs reads the render back.
import { Audio, Composition, OffthreadVideo, registerRoot, Sequence } from 'remotion';

const Media = () => (
  <>
    <Audio src="assets/click.wav" />
    <OffthreadVideo src="assets/gray.mp4" muted style={{ width: 160, height: 90, objectFit: 'fill' }} />
  </>
);

const RateTrim = () => (
  <Sequence from={15} trimBefore={10} playbackRate={2}>
    <Media />
  </Sequence>
);

const Loop = () => (
  <Sequence durationInFrames={30} loop>
    <Media />
  </Sequence>
);

registerRoot(() => (
  <>
    <Composition id="RateTrim" component={RateTrim} width={160} height={90} fps={30} durationInFrames={60} />
    <Composition id="Loop" component={Loop} width={160} height={90} fps={30} durationInFrames={90} />
  </>
));
