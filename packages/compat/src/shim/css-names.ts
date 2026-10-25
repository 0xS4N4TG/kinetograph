// The CSS properties `'transform' in element.style` answers true for. A library that feature-detects a property
// (GSAP's CSSPlugin probes `transform`, `perspective` and their vendor prefixes on a helper element) must find the
// unprefixed names, or it writes nothing. The list is the properties the engine knows how to draw or lay out, plus the
// ones a script is likely to probe; a vendor-prefixed name is not in it, so a probe falls through to the plain one.

const NAMES = `
accentColor alignContent alignItems alignSelf alignmentBaseline all animation animationDelay animationDirection
animationDuration animationFillMode animationIterationCount animationName animationPlayState animationTimingFunction
appearance aspectRatio backdropFilter backfaceVisibility background backgroundAttachment backgroundBlendMode
backgroundClip backgroundColor backgroundImage backgroundOrigin backgroundPosition backgroundPositionX
backgroundPositionY backgroundRepeat backgroundSize baselineShift blockSize border borderBlock borderBottom
borderBottomColor borderBottomLeftRadius borderBottomRightRadius borderBottomStyle borderBottomWidth borderCollapse
borderColor borderImage borderInline borderLeft borderLeftColor borderLeftStyle borderLeftWidth borderRadius
borderRight borderRightColor borderRightStyle borderRightWidth borderSpacing borderStyle borderTop borderTopColor
borderTopLeftRadius borderTopRightRadius borderTopStyle borderTopWidth borderWidth bottom boxDecorationBreak boxShadow
boxSizing breakAfter breakBefore breakInside captionSide caretColor clear clip clipPath clipRule color colorInterpolation
colorScheme columnCount columnFill columnGap columnRule columnRuleColor columnRuleStyle columnRuleWidth columnSpan
columnWidth columns contain content counterIncrement counterReset cssFloat cursor cx cy d direction display
dominantBaseline emptyCells fill fillOpacity fillRule filter flex flexBasis flexDirection flexFlow flexGrow flexShrink
flexWrap float floodColor floodOpacity font fontFamily fontFeatureSettings fontKerning fontOpticalSizing fontSize
fontSizeAdjust fontStretch fontStyle fontSynthesis fontVariant fontVariantCaps fontVariantLigatures fontVariantNumeric
fontVariationSettings fontWeight gap grid gridArea gridAutoColumns gridAutoFlow gridAutoRows gridColumn gridColumnEnd
gridColumnGap gridColumnStart gridGap gridRow gridRowEnd gridRowGap gridRowStart gridTemplate gridTemplateAreas
gridTemplateColumns gridTemplateRows height hyphens imageRendering inherits inlineSize inset insetBlock insetInline
isolation justifyContent justifyItems justifySelf left letterSpacing lightingColor lineBreak lineHeight listStyle
listStyleImage listStylePosition listStyleType margin marginBlock marginBottom marginInline marginLeft marginRight
marginTop marker markerEnd markerMid markerStart mask maskImage maskMode maskPosition maskRepeat maskSize maskType
maxBlockSize maxHeight maxInlineSize maxWidth minBlockSize minHeight minInlineSize minWidth mixBlendMode objectFit
objectPosition offset offsetDistance offsetPath offsetRotate opacity order orphans outline outlineColor outlineOffset
outlineStyle outlineWidth overflow overflowAnchor overflowWrap overflowX overflowY overscrollBehavior padding
paddingBlock paddingBottom paddingInline paddingLeft paddingRight paddingTop pageBreakAfter pageBreakBefore
pageBreakInside paintOrder perspective perspectiveOrigin placeContent placeItems placeSelf pointerEvents position
quotes r resize right rotate rowGap rx ry scale scrollBehavior scrollMargin scrollPadding shapeRendering stopColor
stopOpacity stroke strokeDasharray strokeDashoffset strokeLinecap strokeLinejoin strokeMiterlimit strokeOpacity
strokeWidth tabSize tableLayout textAlign textAlignLast textAnchor textCombineUpright textDecoration textDecorationColor
textDecorationLine textDecorationStyle textDecorationThickness textEmphasis textIndent textJustify textOrientation
textOverflow textRendering textShadow textTransform textUnderlineOffset textUnderlinePosition top touchAction transform
transformBox transformOrigin transformStyle transition transitionDelay transitionDuration transitionProperty
transitionTimingFunction translate unicodeBidi userSelect vectorEffect verticalAlign visibility whiteSpace widows width
willChange wordBreak wordSpacing wordWrap writingMode x y zIndex zoom
`
  .split(/\s+/)
  .filter((name) => name !== '');

const KNOWN = new Set<string>(NAMES);

/** Whether `name` (camelCase, or kebab-case) is a CSS property the style shim answers `in` for. */
export function isKnownCssProperty(name: string): boolean {
  if (name.startsWith('--')) return false;
  return KNOWN.has(name.includes('-') ? name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()) : name);
}
