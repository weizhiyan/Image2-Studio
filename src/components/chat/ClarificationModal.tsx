import { useEffect, useId, useRef, useState } from 'react';
import type { ChatClarificationQuestion } from '@/types';
import { clearClarificationDraft, readClarificationDraft, saveClarificationDraft } from '@/lib/clarificationDrafts';
import './ClarificationModal.css';

const OTHER_VALUE = '__huiban_other__';
const DELEGATE_VALUE = '让 AI 决定';

export interface ClarificationRequest {
  callId: string;
  questions: ChatClarificationQuestion[];
}

export function clarificationQuestionType(question: ChatClarificationQuestion): 'single' | 'multiple' | 'text' {
  return question.type || (question.multiple ? 'multiple' : 'single');
}

export function serializeClarificationAnswers(questions: ChatClarificationQuestion[], answers: Record<string, string[]>, drafts: Record<string, string>): Record<string, string[]> {
  return Object.fromEntries(questions.map((question) => [question.id,
    question.purpose === 'creative' && answers[question.id]?.includes(DELEGATE_VALUE)
      ? [DELEGATE_VALUE]
      : clarificationQuestionType(question) === 'text'
        ? (drafts[question.id]?.trim() ? [drafts[question.id].trim()] : [])
        : (answers[question.id] || []).map((value) => value === OTHER_VALUE ? '其他：' + (drafts[question.id]?.trim() || '') : value).filter(Boolean),
  ]));
}

export default function ClarificationModal({ request, draftKey, onSubmit, onCancel }: {
  request: ClarificationRequest | null;
  draftKey?: string;
  onSubmit: (answers: Record<string, string[]>) => Promise<boolean>;
  onCancel: () => Promise<boolean>;
}) {
  const storageId = draftKey || request?.callId || '';
  const [saved] = useState(() => readClarificationDraft(storageId));
  const [activeIndex, setActiveIndex] = useState(saved?.activeIndex || 0);
  const [answers, setAnswers] = useState<Record<string, string[]>>(saved?.answers || {});
  const [otherDrafts, setOtherDrafts] = useState<Record<string, string>>(saved?.otherDrafts || {});
  const [skipped, setSkipped] = useState<string[]>(saved?.skipped || []);
  const [submitting, setSubmitting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState('');
  const submittingRef = useRef(false);
  const controlId = useId();
  const questions = request?.questions || [];
  const activeQuestion = questions[activeIndex] || questions[0];
  const isLast = activeIndex >= questions.length - 1;

  useEffect(() => {
    if (storageId) saveClarificationDraft(storageId, { activeIndex, answers, otherDrafts, skipped });
  }, [storageId, activeIndex, answers, otherDrafts, skipped]);

  const answered = (question: ChatClarificationQuestion) => {
    if (question.optional && skipped.includes(question.id)) return true;
    if (question.purpose === 'creative' && answers[question.id]?.includes(DELEGATE_VALUE)) return true;
    if (clarificationQuestionType(question) === 'text') return Boolean(otherDrafts[question.id]?.trim());
    const selected = answers[question.id] || [];
    return selected.length > 0 && (!selected.includes(OTHER_VALUE) || Boolean(otherDrafts[question.id]?.trim()));
  };
  const allAnswered = questions.every(answered);

  const toggle = (question: ChatClarificationQuestion, value: string) => {
    setSkipped((current) => current.filter((id) => id !== question.id));
    setAnswers((current) => {
      const selected = (current[question.id] || []).filter((item) => item !== DELEGATE_VALUE);
      return { ...current, [question.id]: value === DELEGATE_VALUE || clarificationQuestionType(question) !== 'multiple'
        ? [value] : selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value] };
    });
  };

  const respond = async (cancel: boolean) => {
    if (!request || submittingRef.current || (!cancel && !allAnswered)) return;
    submittingRef.current = true;
    setSubmitting(true); setError('');
    try {
      const accepted = cancel ? await onCancel() : await onSubmit(serializeClarificationAnswers(questions, answers, otherDrafts));
      if (accepted) clearClarificationDraft(storageId);
      else throw new Error('问题可能已更新，答案仍保留，请重试。');
    } catch (failure) {
      submittingRef.current = false;
      setSubmitting(false);
      setError(failure instanceof Error ? failure.message : '请求失败，答案仍保留，请重试。');
    }
  };

  if (!request || !activeQuestion) return null;
  const type = clarificationQuestionType(activeQuestion);
  const options = [...(activeQuestion.options || []), { label: '其他', value: OTHER_VALUE, description: '输入你的内容' }];

  return <div className="hb-clarification-overlay">
    <section className="hb-clarification-modal" role="group" aria-label="补充生成信息" aria-busy={submitting}>
      <header className="hb-clarification-header">
        <div className="hb-clarification-heading"><div><strong>{activeQuestion.purpose === 'creative' ? '选一个方向' : '确认关键信息'}</strong></div></div>
        <button type="button" className="hb-clarification-secondary" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-controls={controlId}>{collapsed ? '继续回答' : '收起'}</button>
      </header>
      <div id={controlId} className="hb-clarification-content" hidden={collapsed}>
        {questions.length > 1 ? <div className="hb-clarification-tabs" role="group" aria-label="澄清问题">
          {questions.map((question, index) => <button type="button" key={question.id} aria-pressed={activeIndex === index} className={activeIndex === index ? 'is-active' : ''} disabled={submitting} onClick={() => setActiveIndex(index)}>问题 {index + 1}</button>)}
        </div> : null}
        <div className="hb-clarification-body"><div className="hb-clarification-body-inner">
          <div className="hb-clarification-question-head"><h2>{activeQuestion.title}</h2>{activeQuestion.description ? <p>{activeQuestion.description}</p> : null}</div>
          {type === 'text' ? <textarea className="hb-clarification-text" aria-label={activeQuestion.title} rows={3} maxLength={4000} value={otherDrafts[activeQuestion.id] || ''} disabled={submitting} onChange={(event) => {
            setSkipped((current) => current.filter((id) => id !== activeQuestion.id));
            setAnswers((current) => ({ ...current, [activeQuestion.id]: [] }));
            setOtherDrafts((current) => ({ ...current, [activeQuestion.id]: event.target.value }));
          }} /> : <div className="hb-clarification-options" role={type === 'multiple' ? 'group' : 'radiogroup'} aria-label={activeQuestion.title}>
            {options.map((option) => {
              const selected = (answers[activeQuestion.id] || []).includes(option.value);
              return <div key={option.value}>
                <label className={'hb-clarification-option' + (selected ? ' is-selected' : '')}>
                  <input type={type === 'multiple' ? 'checkbox' : 'radio'} name={controlId + activeQuestion.id} checked={selected} disabled={submitting} onChange={() => toggle(activeQuestion, option.value)} />
                  <span className="hb-clarification-control" aria-hidden="true" />
                  <span className="hb-clarification-option-copy"><span className="hb-clarification-option-title"><strong>{option.label}</strong>{'recommended' in option && option.recommended ? <em>推荐</em> : null}</span>{option.description ? <small>{option.description}</small> : null}</span>
                </label>
                {option.value === OTHER_VALUE && selected ? <input className="hb-clarification-other" aria-label="其他内容" placeholder="请输入" value={otherDrafts[activeQuestion.id] || ''} disabled={submitting} onChange={(event) => setOtherDrafts((current) => ({ ...current, [activeQuestion.id]: event.target.value }))} /> : null}
              </div>;
            })}
          </div>}
          {type === 'text' && activeQuestion.purpose === 'creative' ? <button type="button" className="hb-clarification-secondary" aria-pressed={answers[activeQuestion.id]?.includes(DELEGATE_VALUE) || false} disabled={submitting} onClick={() => toggle(activeQuestion, DELEGATE_VALUE)}>让 AI 决定</button> : null}
        </div></div>
        {error ? <p className="hb-chat-error hb-chat-panel-notice" role="alert">{error}</p> : null}
        <footer className="hb-clarification-footer">
          <button type="button" className="hb-clarification-secondary" onClick={() => void respond(true)} disabled={submitting}>取消任务</button>
          {activeQuestion.optional && activeQuestion.purpose !== 'creative' ? <button type="button" className="hb-clarification-secondary" disabled={submitting} onClick={() => {
            setAnswers((current) => ({ ...current, [activeQuestion.id]: [] }));
            setOtherDrafts((current) => ({ ...current, [activeQuestion.id]: '' }));
            setSkipped((current) => [...current.filter((id) => id !== activeQuestion.id), activeQuestion.id]);
            if (!isLast) setActiveIndex((index) => index + 1);
          }}>跳过此题</button> : null}
          <button type="button" className="hb-clarification-primary" disabled={submitting || !answered(activeQuestion) || (isLast && !allAnswered)} title={!answered(activeQuestion) ? '请选择或填写答案' : undefined} onClick={() => { if (isLast) void respond(false); else setActiveIndex((index) => index + 1); }}>{submitting ? '提交中…' : isLast ? '提交' : '下一步'}</button>
        </footer>
      </div>
    </section>
  </div>;
}

