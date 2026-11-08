import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { LessonSteps } from '@/components/lessons/lesson-steps';
import { LESSONS } from '@/lib/lessons';
import { CatalogPage } from '@/sections/catalog';
import { Label } from '@/sections/shared';

export function generateStaticParams() {
  return LESSONS.map((l) => ({ slug: l.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const lesson = LESSONS.find((l) => l.slug === slug);
  return lesson ? { title: `${lesson.title} | Kinetograph lessons`, description: lesson.intro } : {};
}

export default async function LessonPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const lesson = LESSONS.find((l) => l.slug === slug);
  if (!lesson) notFound();
  return (
    <CatalogPage>
      <Label>Lesson</Label>
      <nav aria-label="Breadcrumb" className="mt-3 font-jb text-[12px] tracking-[0.04em] text-mute">
        <a href="/lessons/" className="hover:text-ink">
          Learn
        </a>
        <span aria-hidden> / </span>
        {lesson.group}
      </nav>
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-[clamp(30px,3.6vw,48px)] leading-[1.08] font-bold tracking-[-0.04em] text-ink">{lesson.title}</h1>
        <span className="font-jb text-[11px] tracking-[0.2em] text-mute uppercase">{lesson.minutes} min</span>
      </div>
      <div className="mt-8 max-w-[860px]">
        <LessonSteps lesson={lesson} />
      </div>
    </CatalogPage>
  );
}
