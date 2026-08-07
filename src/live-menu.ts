import { emitKeypressEvents } from 'node:readline';

import { paint, truncate } from './pixel-agent';

export interface MenuOption<T extends string> {
  value: T;
  label: string;
}

interface LiveMenuOptions<T extends string, D> {
  message: string;
  options: MenuOption<T>[];
  /** Expensive: shells out to git and tmux, so it runs on the slow interval. */
  data: () => D;
  /** Cheap: pure formatting, so the sprite can animate between data reads. */
  board: (data: D, tick: number) => string[];
  frameMs?: number;
  dataMs?: number;
}

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/**
 * A menu that owns its own frame. Clack renders once per keypress and exposes
 * no way to repaint from a timer, so a status board that updates while the menu
 * sits open has to draw itself.
 */
export function liveMenu<T extends string, D>({
  message,
  options,
  data,
  board,
  frameMs = 220,
  dataMs = 3000,
}: LiveMenuOptions<T, D>): Promise<T | null> {
  const input = process.stdin;
  const output = process.stdout;

  return new Promise((resolve) => {
    let selected = 0;
    let tick = 0;
    let snapshot = data();
    let drawnLines = 0;

    const render = () => {
      const width = (output.columns ?? 80) - 1;
      const lines = [
        ...board(snapshot, tick),
        '',
        paint(message, 'bold'),
        ...options.map((option, index) =>
          index === selected
            ? paint(`❯ ${option.label}`, 'cyan')
            : paint(`  ${option.label}`, 'dim'),
        ),
        paint('↑/↓ move · enter select · q quit', 'grey'),
      ].map((line) => truncate(line, width));

      // Move back over the previous frame and clear to the end of the screen,
      // so a shorter frame cannot leave orphaned lines behind.
      const prefix = drawnLines ? `\x1b[${drawnLines}A\x1b[0J` : '';
      output.write(`${prefix}${lines.join('\n')}\n`);
      drawnLines = lines.length;
    };

    const frameTimer = setInterval(() => {
      tick += 1;
      render();
    }, frameMs);

    const dataTimer = setInterval(() => {
      snapshot = data();
    }, dataMs);

    const wasRaw = input.isRaw;
    emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    output.write(HIDE_CURSOR);
    input.resume();

    const finish = (value: T | null) => {
      clearInterval(frameTimer);
      clearInterval(dataTimer);
      input.off('keypress', onKeypress);
      if (input.isTTY) input.setRawMode(wasRaw ?? false);
      input.pause();
      output.write(SHOW_CURSOR);
      resolve(value);
    };

    function onKeypress(
      _character: string,
      key: { name?: string; ctrl?: boolean },
    ) {
      if (key.ctrl && key.name === 'c') return finish(null);
      if (key.name === 'escape' || key.name === 'q') return finish(null);
      if (key.name === 'return' || key.name === 'space') {
        return finish(options[selected]?.value ?? null);
      }
      if (key.name === 'up' || key.name === 'k') {
        selected = (selected - 1 + options.length) % options.length;
        return render();
      }
      if (key.name === 'down' || key.name === 'j') {
        selected = (selected + 1) % options.length;
        return render();
      }
    }

    input.on('keypress', onKeypress);
    render();
  });
}
