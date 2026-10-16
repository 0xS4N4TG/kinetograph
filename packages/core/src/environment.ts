// `getRemotionEnvironment()`, written from Remotion's documented shape.
//
// Every frame Kinetograph draws, the studio preview included, comes from the
// same render path, so the answer is always "rendering": a component that
// branches on it draws the same frame in the studio as in the output file.

export interface RemotionEnvironment {
  isStudio: boolean;
  isRendering: boolean;
  isPlayer: boolean;
  isReadOnlyStudio: boolean;
  isClientSideRendering: boolean;
}

export function getRemotionEnvironment(): RemotionEnvironment {
  return { isStudio: false, isRendering: true, isPlayer: false, isReadOnlyStudio: false, isClientSideRendering: false };
}
