'use client';

import { useEffect } from 'react';

import { startSmoothScroll } from '@/lib/smooth-scroll';

/** Starts Lenis smooth scrolling for the page; renders nothing. */
export function SmoothScroll() {
  useEffect(startSmoothScroll, []);
  return null;
}
