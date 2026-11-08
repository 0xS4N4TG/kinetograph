/**
 * The lessons. Each has five steps: Watch (a video, four takeaways, five words), Recap, Words, Quiz and Make it.
 * The video is `VIDEO_BASE + 'lesson-' + slug + '.mp4'`; the script for each is in content/docs/VIDEOS.md.
 */
export interface QuizQuestion {
  question: string;
  options: string[];
  /** Index into `options`. */
  answer: number;
  why: string;
}

export interface Lesson {
  slug: string;
  title: string;
  group: string;
  minutes: number;
  /** What the video runs, shown under it. */
  length: string;
  intro: string;
  takeaways: [string, string, string, string];
  words: { term: string; meaning: string }[];
  recap: string;
  quiz: QuizQuestion[];
  prompt: string;
  practice: { title: string; text: string; prompt: string }[];
  next?: string;
}

export const LESSONS: Lesson[] = [
  {
    slug: 'animate-your-logo',
    title: 'A quick win: animate your logo',
    group: 'Basics',
    minutes: 12,
    length: 'About 2 minutes',
    intro: 'Make a four second logo sting with one request, then fix it with numbers.',
    takeaways: [
      'A short request is enough: how long, what shape, your logo file and any words in quotes.',
      'Put the logo in public/images as an SVG or a transparent PNG, and name the file.',
      'Say the move in plain words, then tune it with numbers: overshoot to 1.08 times its size, then settle.',
      'Say timing in seconds, and change one thing at a time.',
    ],
    words: [
      { term: 'ease out', meaning: 'A move that starts fast and slows into place.' },
      { term: 'ease in', meaning: 'A move that starts slow and speeds up as it leaves.' },
      { term: 'overshoot', meaning: 'Going a little past the resting point, then settling back.' },
      { term: 'linear easing', meaning: 'The same speed the whole way. It reads as mechanical.' },
      { term: 'lockup', meaning: 'The logo and its word, moved together as one unit.' },
    ],
    recap:
      'A good first request names the length, the logo file and the exact words, then describes one move. Enter with an ease-out and a slight overshoot, hold, and leave with an ease-in. When something is off, point at one thing and give a number.',
    quiz: [
      {
        question: 'In a 4 second logo sting, the logo shrinks and fades out at the end. Which ease should that exit use?',
        options: ['An ease-out, so it slows to a clean stop', 'An ease-in, so it speeds up and leaves', 'A linear ease, so it moves at one steady speed', 'No ease, so it cuts out with no motion'],
        answer: 1,
        why: 'Things that leave speed up as they go. An ease-in does that.',
      },
      {
        question: 'Which logo file gives the cleanest result?',
        options: ['A screenshot of the website', 'An SVG or a PNG with a transparent background', 'A JPG with a white background', 'A photo of the logo on a mug'],
        answer: 1,
        why: 'A transparent file has no box round it, so the logo can move over any colour.',
      },
      {
        question: 'Which request is most likely to give the same result twice?',
        options: ['Make it bouncy', 'Make it feel premium', 'Enter over 0.6 seconds, overshoot to 1.08 times its size, then settle', 'Make it pop more'],
        answer: 2,
        why: 'A time and a size leave nothing to guess. A word like "bouncy" can mean many things.',
      },
      {
        question: 'The first draft leaves too late. What do you say next?',
        options: ['Redo the whole thing', 'It should leave at 3.4 seconds. Change nothing else.', 'Make it better', 'Add more motion everywhere'],
        answer: 1,
        why: 'One change at a time, with a number, keeps everything you already like.',
      },
    ],
    prompt:
      'Make a logo sting 4 seconds long with the logo in public/images/logo.svg and the word "Orbit". The lockup enters with an ease-out over 0.6 seconds with a slight overshoot to 1.08 times its size, holds, then exits with an ease-in. No linear easing anywhere. Keep the logo, the word and the colours. Look at the frames, then save it to out/sting.mp4.',
    practice: [
      {
        title: 'Fix the sting',
        text: 'Repair a sting that overshoots too far and leaves with the wrong ease, using a number in your request.',
        prompt:
          'My logo sting overshoots too far and leaves with an ease-out. Make the overshoot 1.08 times its size and make the exit an ease-in. Change nothing else, and show me frames 0, 20 and 100.',
      },
      {
        title: 'Your own sting',
        text: 'A 4 second sting for your own logo, with the same enter and exit you practised.',
        prompt:
          'Make a 4 second sting for my logo in public/images. Enter with an ease-out over 0.6 seconds and a slight overshoot, hold, then exit with an ease-in. Use my name in quotes as the word.',
      },
    ],
    next: 'words-on-your-footage',
  },
  {
    slug: 'words-on-your-footage',
    title: 'Put words on your own footage',
    group: 'Basics',
    minutes: 15,
    length: 'About 2 minutes',
    intro: 'Add captions to a clip you filmed, and make them easy to read.',
    takeaways: [
      'Put the clip in public/video and name the part you want, such as from 2 seconds to 14.',
      'Bring a subtitle file or word timings. Kinetograph does not turn speech into words.',
      'Say how many words show at a time, where they sit and how the current word is marked.',
      'Keep one caption style for the whole video, then ask your agent to run lint.',
    ],
    words: [
      { term: 'subtitle file', meaning: 'A text file of lines with start and end times, such as an SRT or a VTT file.' },
      { term: 'word timings', meaning: 'The time each single word is said. They let the current word light up.' },
      { term: 'safe zone', meaning: 'The part of the picture where text stays clear of the edges.' },
      { term: 'highlight', meaning: 'A colour or weight that marks the word being said.' },
      { term: 'lint', meaning: 'A check that reports text running past its box or the edge of the picture.' },
    ],
    recap:
      'Bring the clip and the timings. Ask for three to five words at a time in the lower third, one clear way to mark the current word, and one style from start to finish. Finish by asking your agent to run lint and look at the frames.',
    quiz: [
      {
        question: 'Where do the caption timings come from?',
        options: ['Kinetograph listens to the clip and writes them', 'Your own speech-to-text tool, as a subtitle file or word timings', 'They are guessed from the length of the clip', 'From the file name'],
        answer: 1,
        why: 'Kinetograph reads timings you bring. It does not transcribe.',
      },
      {
        question: 'About how many words should show at a time?',
        options: ['One whole paragraph', 'Three to five', 'Twenty', 'It does not matter'],
        answer: 1,
        why: 'Short groups stay readable and keep pace with the voice.',
      },
      {
        question: 'Which input lets the word being said light up?',
        options: ['A subtitle file with one line per sentence', 'Word timings', 'A longer clip', 'A bigger font'],
        answer: 1,
        why: 'Only word timings say when each single word starts.',
      },
      {
        question: 'Which check catches text that runs past the edge of the picture?',
        options: ['Rendering twice', 'lint', 'A faster computer', 'Adding a shadow'],
        answer: 1,
        why: 'lint reports overflow, missing fonts and missing files.',
      },
    ],
    prompt:
      'Use public/video/talk.mp4 from 2 seconds to 14. Caption it with public/captions/talk.srt. Show 3 to 5 words at a time in the lower third, Inter 800, white on a 60% black bar, and light the word being said in yellow. Keep the captions inside the safe zone, run lint and fix anything it reports, then save it to out/talk.mp4.',
    practice: [
      {
        title: 'Fix the captions',
        text: 'Repair captions that cover the speaker and show too many words at once.',
        prompt:
          'My captions cover the speaker\'s face and show a whole sentence at once. Move them to the lower third, show 3 to 5 words at a time, and run lint. Change nothing else.',
      },
      {
        title: 'Your own footage',
        text: 'Captions for a clip of your own, in one style.',
        prompt:
          'Caption my clip in public/video with my subtitle file in public/captions. Use one style for the whole video: white text on a dark bar, the current word in yellow.',
      },
    ],
    next: 'paper-cut-or-glitch',
  },
  {
    slug: 'paper-cut-or-glitch',
    title: 'Give a clip a paper-cut or glitch look',
    group: 'Basics',
    minutes: 15,
    length: 'About 2 minutes',
    intro: 'Pick a look, name it as an effect, and keep the part you like while you change the rest.',
    takeaways: [
      'Name the look as an effect, not a mood: "kraft paper, torn edges" or "a datamosh of 45 frames".',
      'A paper cut-out needs a photo whose background is already removed.',
      'A random look comes from a number. The same number gives the same look, so keep it and change one part.',
      'A datamosh needs clips saved as H.264 or MPEG-4.',
    ],
    words: [
      { term: 'cut-out', meaning: 'A photo with its background removed, drawn like a piece of cut paper.' },
      { term: 'match cut', meaning: 'A highlighted word that holds still while the page behind it changes.' },
      { term: 'datamosh', meaning: 'The old picture stays on screen and the next shot\'s motion pushes it around.' },
      { term: 'seed', meaning: 'The number that picks a random look. The same seed gives the same look.' },
      { term: 'slot', meaning: 'One part of a random look, such as the grade or the mirror.' },
    ],
    recap:
      'Ask for a look by its name and its numbers. For paper, give a stock, an edge and cut-outs. For a glitch, give the two clips and the frame count, or a seed. When you like a result, keep the seed and change one slot.',
    quiz: [
      {
        question: 'What does a datamosh need?',
        options: ['Clips saved as H.264 or MPEG-4', 'A GIF', 'Any file at all', 'A clip with no sound'],
        answer: 0,
        why: 'Those formats store the motion the effect pushes the old picture with.',
      },
      {
        question: 'You like a random look. How do you keep it but change the colours?',
        options: ['Try another look', 'Keep the seed and change only the grade', 'Start again with no seed', 'Turn every slot off'],
        answer: 1,
        why: 'The same seed brings the same look back, so you change one part and keep the rest.',
      },
      {
        question: 'What does a paper cut-out need?',
        options: ['A photo with its background already removed', 'A video', 'A screenshot of a web page', 'Nothing'],
        answer: 0,
        why: 'The cut-out takes the picture\'s own outline, so the background must be gone.',
      },
      {
        question: 'Which of these is not one of the five paper stocks?',
        options: ['Newsprint', 'Kraft', 'Cardboard', 'Glossy'],
        answer: 3,
        why: 'The stocks are white, newsprint, kraft, binder and cardboard.',
      },
    ],
    prompt:
      'Use the paper plugin to make a 6 second video. Cut out public/images/me.png (its background is already removed) on kraft paper with torn edges, unfold it from a crumpled packet, then draw a wobbly hand-drawn line round it. Look at the frames, then save it to out/paper.mp4.',
    practice: [
      {
        title: 'Fix the look',
        text: 'Keep a random look you like and change only one part.',
        prompt:
          'Use the hexed plugin on public/video/clip.mp4 with seed 42. Keep everything the same but make the grade a sepia print and turn the mirror off. Show me the same frame before and after.',
      },
      {
        title: 'Your own look',
        text: 'A glitch or a paper cut-out made from your own clip or photo.',
        prompt:
          'Give my clip in public/video a datamosh into my second clip, 45 frames long. Look at the frames, then save a draft.',
      },
    ],
  },
];
