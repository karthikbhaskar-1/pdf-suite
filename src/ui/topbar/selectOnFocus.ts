import { useRef, type FocusEvent, type MouseEvent } from 'react';

/**
 * For a text box that should have all its text selected when the user goes into it, so that typing replaces the value. A
 * plain select() on focus is undone by a real mouse click: the mouse-up that ends the click sets the caret. So the mouse-up
 * that follows the click that focused the box is cancelled. A later click in the box places the caret as usual.
 */
export function useSelectOnFocus(): {
  onFocus: (event: FocusEvent<HTMLInputElement>) => void;
  onMouseUp: (event: MouseEvent<HTMLInputElement>) => void;
  onBlur: () => void;
} {
  const fresh = useRef(false);
  return {
    onFocus: (event) => {
      fresh.current = true;
      event.currentTarget.select();
    },
    onMouseUp: (event) => {
      if (!fresh.current) return;
      fresh.current = false;
      event.preventDefault();
    },
    onBlur: () => {
      fresh.current = false;
    },
  };
}
