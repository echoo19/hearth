/**
 * A provider-neutral question, inline where the agent paused.
 *
 * Native form controls are deliberate: every value has a typed affordance,
 * browser validation remains useful, and keyboard/screen-reader behavior does
 * not depend on a bespoke widget. Values live only in this component until
 * they cross the socket; settlement clears and unmounts every field.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { pendingInputId, useApp } from '../../store';
import type { ChatInputPart, InputAnswer, InputQuestion } from '../../types';
import { Button } from '../ui/Button';

export interface InputPromptProps {
  part: ChatInputPart;
  /** Controlled lanes provide their own active ask instead of reading the lead transcript. */
  active?: boolean;
  onRespond?: (
    inputId: string,
    action: 'submit' | 'cancel',
    answers?: Record<string, InputAnswer>,
  ) => boolean;
}

type DraftAnswers = Record<string, InputAnswer | undefined>;

function settledVerb(resolution: NonNullable<ChatInputPart['resolution']>): string {
  if (resolution === 'withdrawn') return 'Withdrawn';
  return resolution === 'submit' ? 'Answered' : 'Cancelled';
}

function ChoiceField({
  question,
  value,
  onChange,
  prefix,
}: {
  question: InputQuestion;
  value: InputAnswer | undefined;
  onChange(value: InputAnswer): void;
  prefix: string;
}) {
  const selected = Array.isArray(value) ? value : typeof value === 'string' ? value : '';
  const knownValues = new Set(question.options?.map((option) => option.value));
  const otherSelected =
    question.allowOther && typeof value === 'string' && !knownValues.has(value);

  if (question.multiple) {
    const checked = Array.isArray(value) ? value : [];
    const otherValue = checked.find((entry) => !knownValues.has(entry));
    const hasOther = otherValue !== undefined;
    return (
      <div className="input-options">
        {question.options?.map((option) => (
          <label className="input-option" key={option.value}>
            <input
              type="checkbox"
              name={question.id}
              value={option.value}
              checked={checked.includes(option.value)}
              onChange={(event) =>
                onChange(
                  event.currentTarget.checked
                    ? [...checked, option.value]
                    : checked.filter((entry) => entry !== option.value),
                )
              }
            />
            <span>
              <span className="input-option-label">{option.label}</span>
              {option.description && <span className="input-option-description">{option.description}</span>}
            </span>
          </label>
        ))}
        {question.allowOther && (
          <label className="input-option input-option-other">
            <input
              type="checkbox"
              name={question.id}
              value="__other__"
              checked={hasOther}
              onChange={(event) =>
                onChange(
                  event.currentTarget.checked
                    ? [...checked, '']
                    : checked.filter((entry) => knownValues.has(entry)),
                )
              }
            />
            <span className="input-option-label">Other</span>
            <input
              id={`${prefix}-${question.id}-other`}
              className="input-control"
              type="text"
              aria-label={`${question.label}: Other`}
              value={otherValue ?? ''}
              onFocus={() => {
                if (!hasOther) onChange([...checked, '']);
              }}
              onChange={(event) =>
                onChange([
                  ...checked.filter((entry) => knownValues.has(entry)),
                  event.currentTarget.value,
                ])
              }
            />
          </label>
        )}
      </div>
    );
  }

  return (
    <div className="input-options">
      {question.options?.map((option) => (
        <label className="input-option" key={option.value}>
          <input
            type="radio"
            name={question.id}
            value={option.value}
            required={question.required}
            checked={selected === option.value}
            onChange={() => onChange(option.value)}
          />
          <span>
            <span className="input-option-label">{option.label}</span>
            {option.description && <span className="input-option-description">{option.description}</span>}
          </span>
        </label>
      ))}
      {question.allowOther && (
        <label className="input-option input-option-other">
          <input
            type="radio"
            name={question.id}
            value="__other__"
            required={question.required}
            checked={otherSelected}
            onChange={() => onChange('')}
          />
          <span className="input-option-label">Other</span>
          <input
            id={`${prefix}-${question.id}-other`}
            className="input-control"
            type="text"
            aria-label={`${question.label}: Other`}
            value={otherSelected ? selected : ''}
            onFocus={() => {
              if (!otherSelected) onChange('');
            }}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </label>
      )}
    </div>
  );
}

function QuestionField({
  question,
  value,
  onChange,
  prefix,
  error,
}: {
  question: InputQuestion;
  value: InputAnswer | undefined;
  onChange(value: InputAnswer): void;
  prefix: string;
  error?: string;
}) {
  const id = `${prefix}-${question.id}`;
  const errorId = `${id}-error`;

  if (question.type === 'choice') {
    return (
      <fieldset className="input-question">
        <legend>
          {question.label}
          {question.required && <span aria-hidden="true"> *</span>}
        </legend>
        <ChoiceField question={question} value={value} onChange={onChange} prefix={prefix} />
        {error && (
          <p id={errorId} className="input-error" role="alert">
            {error}
          </p>
        )}
      </fieldset>
    );
  }

  if (question.type === 'boolean') {
    if (question.required) {
      return (
        <fieldset className="input-question">
          <legend>
            {question.label}
            <span aria-hidden="true"> *</span>
          </legend>
          <div className="input-options">
            {[
              { label: 'Yes', answer: true },
              { label: 'No', answer: false },
            ].map((option) => (
              <label className="input-option" key={option.label}>
                <input
                  type="radio"
                  name={question.id}
                  required
                  checked={value === option.answer}
                  onChange={() => onChange(option.answer)}
                />
                <span className="input-option-label">{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
    return (
      <label className="input-boolean" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span>{question.label}</span>
      </label>
    );
  }

  const textValue = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return (
    <label className="input-question input-question-field" htmlFor={id}>
      <span>
        {question.label}
        {question.required && <span aria-hidden="true"> *</span>}
      </span>
      <input
        id={id}
        className="input-control"
        type={question.secret ? 'password' : question.type}
        required={question.required}
        placeholder={question.placeholder}
        min={question.min}
        max={question.max}
        value={textValue}
        autoComplete={question.secret ? 'off' : undefined}
        spellCheck={question.secret ? false : undefined}
        onChange={(event) =>
          onChange(
            question.type === 'number' && event.currentTarget.value !== ''
              ? event.currentTarget.valueAsNumber
              : event.currentTarget.value,
          )
        }
      />
    </label>
  );
}

export function InputPrompt({ part, active: activeProp, onRespond }: InputPromptProps) {
  const answerChatInput = useApp((state) => state.answerChatInput);
  const leadActive = useApp((state) => pendingInputId(state.messages) === part.id);
  const active = activeProp ?? leadActive;
  const answer = onRespond ?? answerChatInput;
  const [values, setValues] = useState<DraftAnswers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const prefix = useId().replace(/:/g, '');
  const pending = part.resolution === null;
  const title = part.title || 'Agent question';

  useEffect(() => {
    if (!active || !pending) return;
    const first = formRef.current?.querySelector<HTMLElement>('input, button');
    first?.focus();
  }, [active, pending]);

  useEffect(() => {
    if (!pending) {
      setValues({});
      setErrors({});
    }
  }, [pending]);

  if (!pending) {
    return (
      <p className="input-record" data-resolution={part.resolution}>
        {settledVerb(part.resolution!)} <span>{title}</span>
        {part.resolution === 'withdrawn' && ': the session ended before you answered'}
      </p>
    );
  }

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    for (const question of part.questions) {
      const value = values[question.id];
      if (question.required && question.type === 'choice' && question.multiple) {
        const selected = Array.isArray(value) ? value.filter((entry) => entry.trim() !== '') : [];
        if (selected.length === 0) nextErrors[question.id] = 'Choose at least one option.';
      } else if (
        question.required &&
        question.type === 'choice' &&
        question.allowOther &&
        value === ''
      ) {
        nextErrors[question.id] = 'Enter an answer for Other.';
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const answers: Record<string, InputAnswer> = {};
    for (const question of part.questions) {
      const value = values[question.id];
      if (Array.isArray(value)) {
        const selected = value.filter((entry) => entry.trim() !== '');
        if (selected.length > 0) answers[question.id] = selected;
      } else if (value !== undefined && value !== '') answers[question.id] = value;
      else if (question.type === 'boolean') answers[question.id] = false;
    }
    if (answer(part.id, 'submit', answers)) setValues({});
  };

  const cancel = (): void => {
    if (answer(part.id, 'cancel')) setValues({});
  };

  return (
    <form
      ref={formRef}
      className="input-prompt"
      role="group"
      aria-label={title}
      aria-live="polite"
      onSubmit={submit}
    >
      <div className="input-heading">
        <p className="input-title">{title}</p>
        {part.description && <p className="input-description">{part.description}</p>}
      </div>
      <div className="input-fields">
        {part.externalAction && (
          <a
            className="input-external-action"
            href={part.externalAction.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in browser
          </a>
        )}
        {part.questions.map((question) => (
          <QuestionField
            key={question.id}
            question={question}
            value={values[question.id]}
            prefix={prefix}
            error={errors[question.id]}
            onChange={(value) => {
              setValues((current) => ({ ...current, [question.id]: value }));
              setErrors((current) => {
                if (!(question.id in current)) return current;
                const next = { ...current };
                delete next[question.id];
                return next;
              });
            }}
          />
        ))}
      </div>
      <div className="input-actions">
        <Button variant="primary" type="submit">
          Continue
        </Button>
        {part.allowCancel && <Button onClick={cancel}>Cancel</Button>}
        {part.timeoutMs && (
          <span className="input-timeout">The agent may continue automatically after {Math.ceil(part.timeoutMs / 1000)}s.</span>
        )}
      </div>
    </form>
  );
}
