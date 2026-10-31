import { useEffect, useId, useState } from 'react';
import type { ChatClarificationQuestion } from '@/types';
import './ClarificationModal.css';

const OTHER_VALUE = '__huiban_other__';

export interface ClarificationRequest {
  callId: string;
  questions: ChatClarificationQuestion[];
}

export function clarificationQuestionType(question: ChatClarificationQuestion): 'single' | 'multiple' | 'text' {
  return question.type || (question.multiple ? 'multiple' : 'single');
}

export function serializeClarificationAnswers(questions: ChatClarificationQuestion[], answers: Record<string, string[]>, drafts: Record<string, string>): Record<string, string[]> {
  return Object.fromEntries(questions.map((question) => [question.id,
    clarificationQuestionType(question) === 'text'
      ? (drafts[question.id]?.trim() ? [drafts[question.id].trim()] : [])
      : (answers[question.id] || []).map((value) => value === OTHER_VALUE ? `其他：${drafts[question.id]?.trim() || ''}` : value).filter(Boolean),
  ]));
}

export default function ClarificationModal({
  request,
  onSubmit,
  onCancel,
}: {
  request: ClarificationRequest | null;
  onSubmit: (answers: Record<string, string[]>) => Promise<boolean>;
  onCancel: () => Promise<boolean>;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [otherDrafts, setOtherDrafts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const tabsId = useId();
  const questions = request?.questions || [];
  const activeQuestion = questions[activeIndex];

  useEffect(() => {
    setActiveIndex(0);
    setAnswers({});
    setOtherDrafts({});
    setSkipped([]);
    setSubmitting(false);
  }, [request?.callId]);

  const isLast = activeIndex === questions.length - 1;
  const answered = (question: ChatClarificationQuestion) => {
    if (question.optional && skipped.includes(question.id)) return true;
    if (clarificationQuestionType(question) === 'text') return Boolean(otherDrafts[question.id]?.trim());
    const selected = answers[question.id] || [];
    return selected.length > 0 && (!selected.includes(OTHER_VALUE) || Boolean(otherDrafts[question.id]?.trim()));
  };
  const allAnswered = questions.every(answered);
  const currentAnswered = activeQuestion ? answered(activeQuestion) : false;

  const toggle = (question: ChatClarificationQuestion, value: string) => {
    setSkipped((current) => current.filter((id) => id !== question.id));
    setAnswers((current) => {
      const selected = current[question.id] || [];
      if (clarificationQuestionType(question) === 'multiple') {
        return {
          ...current,
          [question.id]: selected.includes(value)
            ? selected.filter((item) => item !== value)
            : [...selected, value],
        };
      }
      return { ...current, [question.id]: [value] };
    });
    if (clarificationQuestionType(question) === 'single' && value !== OTHER_VALUE) {
      setActiveIndex((index) => Math.min(questions.length - 1, index + 1));
    }
  };

  const submit = () => {
    if (!request || !activeQuestion) return;
    const serialized = serializeClarificationAnswers(questions, answers, otherDrafts);
    setSubmitting(true);
    void onSubmit(serialized).then((accepted) => {
      if (!accepted) setSubmitting(false);
    }).catch(() => setSubmitting(false));
  };

  const cancel = () => {
    if (submitting || !request) return;
    setSubmitting(true);
    void onCancel().then((accepted) => {
      if (!accepted) setSubmitting(false);
    }).catch(() => setSubmitting(false));
  };

  useEffect(() => {
    if (!request) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [request?.callId, submitting, onCancel]);

  if (!request || questions.length === 0 || !activeQuestion) return null;

  return (
    <div className="hb-clarification-overlay">
      <section className="hb-clarification-modal" role="group" aria-label="补充生成信息">
        <header className="hb-clarification-header">
          <div className="hb-clarification-heading">
            <div>
              <strong>补充几个信息</strong>
            </div>
          </div>
          <button type="button" className="hb-clarification-close" onClick={cancel} aria-label="取消任务" disabled={submitting}>×</button>
        </header>

        {questions.length > 1 ? (
          <div className="hb-clarification-tabs" role="tablist" aria-label="澄清问题">
            {questions.map((question, index) => (
              <button
                type="button"
                role="tab"
                key={question.id}
                id={`${tabsId}-tab-${index}`}
                aria-selected={activeIndex === index}
                className={activeIndex === index ? 'is-active' : ''}
                disabled={submitting}
                onClick={() => setActiveIndex(index)}
              >
                <span>{`问题 ${index + 1}`}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="hb-clarification-body">
          <div className="hb-clarification-body-inner">
            <div className="hb-clarification-question-head">
              <h2>{activeQuestion.title}</h2>
              {activeQuestion.description ? <p>{activeQuestion.description}</p> : null}
            </div>
            {clarificationQuestionType(activeQuestion) === 'text' ? (
              <textarea
                className="hb-clarification-text"
                aria-label={activeQuestion.title}
                autoFocus
                rows={4}
                maxLength={6000}
                value={otherDrafts[activeQuestion.id] || ''}
                disabled={submitting}
                onChange={(event) => {
                  setSkipped((current) => current.filter((id) => id !== activeQuestion.id));
                  setOtherDrafts((current) => ({ ...current, [activeQuestion.id]: event.target.value }));
                }}
              />
            ) : <div className="hb-clarification-options" role={clarificationQuestionType(activeQuestion) === 'multiple' ? 'group' : 'radiogroup'}>
              {[...(activeQuestion.options || []), { label: '其他', value: OTHER_VALUE, description: '输入你的内容' }].map((option) => {
                const selected = (answers[activeQuestion.id] || []).includes(option.value);
                const inputType = clarificationQuestionType(activeQuestion) === 'multiple' ? 'checkbox' : 'radio';
                return (
                  <label className={`hb-clarification-option ${selected ? 'is-selected' : ''}`} key={option.value}>
                    <input
                      type={inputType}
                      name={activeQuestion.id}
                      checked={selected}
                      disabled={submitting}
                      onChange={() => toggle(activeQuestion, option.value)}
                    />
                    <span className="hb-clarification-control" aria-hidden="true" />
                    <span className="hb-clarification-option-copy">
                      <span className="hb-clarification-option-title">
                        <strong>{option.label}</strong>
                        {option.recommended ? <em>推荐</em> : null}
                      </span>
                      {option.description && !(option.value === OTHER_VALUE && selected) ? <small>{option.description}</small> : null}
                    </span>
                    {option.value === OTHER_VALUE && selected ? (
                      <input
                        className="hb-clarification-other"
                        value={otherDrafts[activeQuestion.id] || ''}
                        disabled={submitting}
                        placeholder="请输入"
                        aria-label="其他内容"
                        onChange={(event) => setOtherDrafts((current) => ({ ...current, [activeQuestion.id]: event.target.value }))}
                      />
                    ) : null}
                  </label>
                );
              })}
            </div>}
          </div>
        </div>

        <footer className="hb-clarification-footer">
          <button type="button" className="hb-clarification-secondary" onClick={cancel} disabled={submitting}>取消任务</button>
          {activeQuestion.optional ? <button type="button" className="hb-clarification-secondary" disabled={submitting} onClick={() => {
            setAnswers((current) => ({ ...current, [activeQuestion.id]: [] }));
            setOtherDrafts((current) => ({ ...current, [activeQuestion.id]: '' }));
            setSkipped((current) => [...current.filter((id) => id !== activeQuestion.id), activeQuestion.id]);
            if (!isLast) setActiveIndex((index) => index + 1);
          }}>跳过此题</button> : null}
          <button
            type="button"
            className="hb-clarification-primary"
            disabled={submitting || !currentAnswered || (isLast && !allAnswered)}
            onClick={() => {
              if (!isLast) setActiveIndex((index) => Math.min(questions.length - 1, index + 1));
              else submit();
            }}
          >
            {submitting ? '提交中…' : isLast ? '提交' : '下一步'}
          </button>
        </footer>
      </section>
    </div>
  );
}

