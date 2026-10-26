import { describe, it, expect } from 'vitest';
import {
  artifactFiles,
  buildItems,
  menuKeys,
  parseMenu,
  promptParts,
} from '../chat';
import type { ChatMessage } from '../chat';

// Screens captured from Claude Code 2.1 in tmux.
const QUESTION = [
  '❯ Use the AskUserQuestion tool to ask me two questions',
  '─'.repeat(60),
  '←  ☐ Color  ☐ Pet  ✔ Submit  →',
  'What is your favorite color?',
  '❯ 1. Red',
  '     The color red',
  '  2. Blue',
  '     The color blue',
  '  3. Type something.',
  '─'.repeat(60),
  '  4. Chat about this',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
];

const REVIEW = [
  '←  ☒ Color  ☒ Pet  ✔ Submit  →',
  'Review your answers',
  ' ● What is your favorite color?',
  '   → Blue',
  'Ready to submit your answers?',
  '❯ 1. Submit answers',
  '  2. Cancel',
];

const PROMPT_LINE = [
  '⏺ Done.',
  '─'.repeat(60),
  '❯ a message being typed',
  '  over two lines',
  '─'.repeat(60),
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
];

describe('parseMenu', () => {
  it('reads a question: options, details, the option past the rule', () => {
    const menu = parseMenu(QUESTION)!;
    expect(menu.options.map((o) => o.label)).toEqual([
      '1. Red',
      '2. Blue',
      '3. Type something.',
      '4. Chat about this',
    ]);
    expect(menu.options[1].detail).toBe('The color blue');
    expect(menu.selected).toBe(0);
    expect(menu.prompt).toEqual([
      '←  ☐ Color  ☐ Pet  ✔ Submit  →',
      'What is your favorite color?',
    ]);
  });

  it('reads a numbered menu without a keys hint', () => {
    const menu = parseMenu(REVIEW)!;
    expect(menu.options.map((o) => o.label)).toEqual([
      '1. Submit answers',
      '2. Cancel',
    ]);
    expect(menu.prompt.at(-1)).toBe('Ready to submit your answers?');
  });

  it('does not take the prompt line for a menu', () => {
    expect(parseMenu(PROMPT_LINE)).toBeNull();
    expect(parseMenu(['❯ ', ''])).toBeNull();
  });

  it('picks with arrows and Enter; "Type something" gets no Enter', () => {
    const menu = parseMenu(QUESTION)!;
    expect(menuKeys(menu, 1)).toEqual(['\x1b[B', '\r']);
    expect(menuKeys(menu, 2)).toEqual(['\x1b[B', '\x1b[B']);
    expect(menuKeys({ ...menu, selected: 3 }, 0)).toEqual([
      '\x1b[A',
      '\x1b[A',
      '\x1b[A',
      '\r',
    ]);
  });
});

describe('buildItems', () => {
  it('folds calls across messages; text splits the groups', () => {
    const call = (id: string): ChatMessage => ({
      id,
      ts: null,
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: `t${id}`, name: 'Bash', input: {} }],
    });
    const items = buildItems([
      call('1'),
      {
        id: 'r',
        ts: null,
        role: 'user',
        blocks: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            text: '',
            is_error: false,
            truncated: false,
            images: [],
          },
        ],
      },
      call('2'),
      {
        id: 'x',
        ts: null,
        role: 'assistant',
        blocks: [{ type: 'text', text: 'ok' }],
      },
      call('3'),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['tools', 'message', 'tools']);
    expect(items[0].kind === 'tools' && items[0].tools).toHaveLength(2);
  });
});

describe('promptParts', () => {
  it('drops the pasted_content tags and sets the pasted text apart', () => {
    expect(
      promptParts(
        'veja isto:\n\n<pasted_content id="f3ec">\nlinha 1\nlinha 2\n</pasted_content id="f3ec">\ne corrija',
      ),
    ).toEqual([
      { text: 'veja isto:', pasted: false },
      { text: 'linha 1\nlinha 2', pasted: true },
      { text: 'e corrija', pasted: false },
    ]);
    expect(promptParts('<pasted_content id="1">\ncortado')).toEqual([
      { text: 'cortado', pasted: false },
    ]);
  });
});

describe('artifactFiles', () => {
  it('maps the address in the result to the published file', () => {
    const files = artifactFiles(
      [
        {
          id: 'm',
          ts: null,
          role: 'assistant',
          blocks: [
            {
              type: 'tool_use',
              id: 'p',
              name: 'Artifact',
              input: { file_path: '/tmp/s/plan.html' },
            },
          ],
        },
      ],
      new Map([
        [
          'p',
          {
            type: 'tool_result',
            tool_use_id: 'p',
            text: 'Published at https://claude.ai/code/artifact/ab-12 (version 3)',
            is_error: false,
            truncated: false,
            images: [],
          },
        ],
      ]),
    );
    expect(files.get('https://claude.ai/code/artifact/ab-12')).toBe(
      '/tmp/s/plan.html',
    );
  });
});
