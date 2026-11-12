import { FitLine } from '@/components/fit-line';
import { Pic } from '@/components/pic';
import { shell } from '@/sections/shared';

/** Where the name comes from: the Black Maria, on the cobalt field. */
export function Origin() {
  return (
    <section id="origin" className={`${shell} pt-[clamp(48px,6vw,88px)] scroll-mt-6`}>
      <p data-reveal className="mb-6 max-w-[60ch] font-dm text-[clamp(18px,1.6vw,22px)] leading-snug font-medium tracking-[-0.01em] text-ink">
        The first film studio turned on a track to follow the sun. This one runs on your computer.
      </p>
      <div data-reveal className="group/pic kg-tray">
        <div className="kg-core kg-core-field grid lg:grid-cols-[5fr_7fr]">
          <div className="flex flex-col justify-between gap-12 p-[clamp(24px,3.4vw,52px)] max-lg:order-2">
            <h2 aria-label="Origin">
              <FitLine text="ORIGIN" r={1.925} still />
            </h2>
            <p className="max-w-[40ch] font-dm text-[clamp(17px,1.4vw,19px)] leading-[1.55] tracking-[-0.005em] text-on-field/95">
              The Black Maria was Edison's film studio at West Orange, built in 1893 on a circular track so it could turn to
              follow the sun. The Kinetograph was the camera used there.
            </p>
          </div>
          <Pic
            tint="/retro/origin-maria.webp"
            orig="/retro/origin-maria.jpg"
            alt="The Black Maria film studio at West Orange, New Jersey, in the 1890s: a long dark wooden building with a steep roof."
            className="aspect-[5/3] rounded-none shadow-none max-lg:order-1 lg:aspect-auto lg:min-h-[420px]"
          />
        </div>
      </div>
    </section>
  );
}
