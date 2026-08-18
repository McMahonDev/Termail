import React from 'react';
import { Text } from 'ink';
import type { Key } from 'ink';

export type InputState = { value: string; cursor: number };

export function inputState(value = ''): InputState {
  return { value, cursor: value.length };
}

/**
 * Ink has no built-in text field. Rather than give every field its own
 * `useInput`, forms keep one key handler and funnel keystrokes through here for
 * whichever field has focus. Returns null when the key isn't ours to consume,
 * so the caller can treat it as navigation.
 */
export function applyKey(state: InputState, input: string, key: Key): InputState | null {
  const { value } = state;
  const cursor = Math.max(0, Math.min(state.cursor, value.length));

  if (key.leftArrow) {
    return { value, cursor: Math.max(0, cursor - 1) };
  }
  if (key.rightArrow) {
    return { value, cursor: Math.min(value.length, cursor + 1) };
  }
  if (key.ctrl && input === 'a') {
    return { value, cursor: 0 };
  }
  if (key.ctrl && input === 'e') {
    return { value, cursor: value.length };
  }
  if (key.ctrl && input === 'u') {
    return { value: value.slice(cursor), cursor: 0 };
  }
  if (key.ctrl && input === 'k') {
    return { value: value.slice(0, cursor), cursor };
  }
  if (key.backspace) {
    if (cursor === 0) {
      return { value, cursor };
    }
    return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
  }
  if (key.delete) {
    // Many terminals report backspace as `delete`; treat a delete at the end of
    // the line as a backspace so the key does something sensible either way.
    if (cursor >= value.length) {
      if (cursor === 0) {
        return { value, cursor };
      }
      return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
    }
    return { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor };
  }

  // Printable characters only — control sequences arrive here as multi-char
  // strings and would otherwise be pasted into the field verbatim.
  if (!key.ctrl && !key.meta && input && [...input].every((char) => char >= ' ' && char !== '')) {
    return { value: value.slice(0, cursor) + input + value.slice(cursor), cursor: cursor + input.length };
  }

  return null;
}

type FieldProps = {
  label: string;
  state: InputState;
  focused: boolean;
  mask?: boolean;
  placeholder?: string;
  labelWidth?: number;
  hint?: string;
};

export function Field({ label, state, focused, mask, placeholder, labelWidth = 14, hint }: FieldProps) {
  const shown = mask ? '•'.repeat(state.value.length) : state.value;
  const cursor = Math.max(0, Math.min(state.cursor, shown.length));
  const paddedLabel = `${label}:`.padEnd(labelWidth);

  if (!focused) {
    return (
      <Text>
        <Text color="gray">{paddedLabel}</Text>
        <Text color={shown ? undefined : 'gray'}>{shown || placeholder || '(empty)'}</Text>
      </Text>
    );
  }

  return (
    <Text>
      <Text color="cyan">{paddedLabel}</Text>
      <Text>{shown.slice(0, cursor)}</Text>
      <Text inverse>{shown[cursor] ?? ' '}</Text>
      <Text>{shown.slice(cursor + 1)}</Text>
      {!shown && placeholder ? <Text color="gray"> {placeholder}</Text> : null}
      {hint ? <Text color="gray">  {hint}</Text> : null}
    </Text>
  );
}
