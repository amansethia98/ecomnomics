import { useLingui } from "@lingui/react/macro";
import type { StaffBlock, StaffChoiceBlock, StaffMessage, StaffThread } from "@rakazo/contracts";
import {
  formatCivilDay,
  formatRupees,
  formatSignedPct,
  STAFF_QUESTION_LIMIT,
} from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Mic, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChangeBadge } from "./marks";
import { PlotFigure } from "./plot-figure";

export function StaffScreen({
  restaurantId,
  thread,
  notice,
  onAsk,
  onChoose,
}: {
  restaurantId: string;
  thread: StaffThread;
  notice?: string | null;
  onAsk: (text: string, key: string) => void;
  onChoose: (actionId: string, choice: "approve" | "change" | "not_now") => void;
}) {
  const { t } = useLingui();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [askKey, setAskKey] = useState(() => crypto.randomUUID());
  const disabled = thread.quota.inputDisabled || sending;
  useEffect(() => {
    setSending(false);
  }, [thread.messages.length]);
  const ask = (next: string) => {
    if (!next || disabled) return;
    setSending(true);
    onAsk(next, askKey);
    setAskKey(crypto.randomUUID());
    setText("");
  };
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <header className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-full bg-background">
          <Sparkles aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t`Chief of staff`}</p>
          <p className="text-body-sm text-muted-foreground">
            {t`Knows your Zomato & Swiggy numbers · nothing changes without your OK`}
          </p>
        </div>
        <button type="button" className="text-body-sm text-primary" onClick={() => setText("")}>
          {t`New chat`}
        </button>
      </header>
      {thread.greeting ? (
        <p className="text-body-sm text-muted-foreground">{thread.greeting}</p>
      ) : null}
      {thread.messages.map((message, index) => (
        <div key={message.id}>
          {index === 0 || thread.messages[index - 1]?.date !== message.date ? (
            <p className="my-2 text-center text-label text-muted-foreground">
              {formatCivilDay(message.date)}
            </p>
          ) : null}
          <Message message={message} restaurantId={restaurantId} onChoose={onChoose} />
        </div>
      ))}
      {thread.starters.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {thread.starters.map((starter) => (
            <button
              key={starter}
              type="button"
              className="rounded-full border border-border bg-background px-3 py-1 text-body-sm"
              disabled={disabled}
              onClick={() => ask(starter)}
            >
              {starter}
            </button>
          ))}
        </div>
      ) : null}
      {thread.quota.showCounter ? (
        <p className="text-body-sm text-muted-foreground">
          {t`${thread.quota.remaining} of ${STAFF_QUESTION_LIMIT} questions left today`}
        </p>
      ) : null}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          ask(text.trim());
        }}
      >
        <input
          aria-label={t`Question`}
          className="h-11 min-w-0 flex-1 rounded-full border border-border bg-background px-4 text-body"
          disabled={disabled}
          value={text}
          placeholder={
            disabled && thread.quota.inputDisabled
              ? t`You've used today's 30 questions. Resets at midnight.`
              : t`Ask anything about your business…`
          }
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="button"
          aria-label={t`Voice`}
          className="flex size-11 items-center justify-center rounded-full border border-border"
          disabled={disabled}
        >
          <Mic aria-hidden="true" className="size-4" />
        </button>
        <Button
          type="submit"
          className="size-11 rounded-full px-0"
          disabled={disabled || text.trim().length === 0}
          aria-label={t`Send`}
        >
          {t`Send`}
        </Button>
      </form>
      {notice ? <p className="text-body-sm text-destructive">{notice}</p> : null}
    </div>
  );
}

function Message({
  message,
  restaurantId,
  onChoose,
}: {
  message: StaffMessage;
  restaurantId: string;
  onChoose: (actionId: string, choice: "approve" | "change" | "not_now") => void;
}) {
  const { t } = useLingui();
  const mine = message.role === "owner";
  return (
    <div className={mine ? "mt-2 flex justify-end" : "mt-2 flex items-start gap-2"}>
      {mine ? null : (
        <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-background">
          <Sparkles aria-hidden="true" className="size-3.5" />
        </span>
      )}
      <div
        className={
          mine
            ? "max-w-[80%] rounded-2xl bg-primary px-3 py-2 text-primary-foreground"
            : "max-w-[80%] rounded-2xl bg-background px-3 py-2"
        }
      >
        {message.older ? (
          <p className="text-label text-muted-foreground">{t`older answer`}</p>
        ) : null}
        {message.blocks.map((block, index) => (
          <Block
            key={`${message.id}-${index}`}
            block={block}
            restaurantId={restaurantId}
            onChoose={onChoose}
          />
        ))}
      </div>
    </div>
  );
}

function Block({
  block,
  restaurantId,
  onChoose,
}: {
  block: StaffBlock;
  restaurantId: string;
  onChoose: (actionId: string, choice: "approve" | "change" | "not_now") => void;
}) {
  const { t } = useLingui();
  if (block.kind === "text") {
    if (block.chip) return <span className="owner-pill mt-2 mr-2">{block.text}</span>;
    if (block.heading) return <h3 className="mt-2 text-heading3 font-medium">{block.text}</h3>;
    return <p className="mt-2">{block.text}</p>;
  }
  if (block.kind === "metric") {
    return (
      <div className="mt-3">
        {block.label.includes("urgent") ? (
          <p className="flex flex-wrap gap-2">
            <span className="owner-pill owner-pill-act">{block.label}</span>
            {block.watch != null ? (
              <span className="owner-pill owner-pill-watch">
                {block.watch === 1 ? t`Watch (1)` : t`Watch (${block.watch})`}
              </span>
            ) : null}
          </p>
        ) : (
          <p className="text-label text-muted-foreground">{block.label}</p>
        )}
        <p className="text-heading3 font-medium">
          {block.paise != null ? formatRupees(block.paise) : t`Not in yet`}
        </p>
        {block.changePct != null && block.compare ? (
          <ChangeBadge
            direction={block.changePct < 0 ? "down" : "up"}
            label={
              block.compare.startsWith("vs ")
                ? `${formatSignedPct(block.changePct)} ${block.compare}`
                : `${formatSignedPct(block.changePct)} vs ${block.compare}`
            }
          />
        ) : null}
        {block.pending ? (
          <p className="text-body-sm text-muted-foreground">
            {block.pending === "swiggy" ? t`Swiggy pending` : t`Zomato pending`}
          </p>
        ) : null}
      </div>
    );
  }
  if (block.kind === "chart") return <PlotFigure plot={block.plot} />;
  return <Choice block={block} restaurantId={restaurantId} onChoose={onChoose} />;
}

function Choice({
  block,
  restaurantId,
  onChoose,
}: {
  block: StaffChoiceBlock;
  restaurantId: string;
  onChoose: (actionId: string, choice: "approve" | "change" | "not_now") => void;
}) {
  const { t } = useLingui();
  if (block.answerId === "approve") {
    return (
      <p className="mt-3">
        <Link className="text-primary" to={`/restaurants/${restaurantId}/marketing`}>
          {t`Approved · saved to Marketing actions`}
        </Link>
      </p>
    );
  }
  if (block.answerId) return null;
  return (
    <div className="mt-3">
      <p className="font-medium">{block.question}</p>
      <p className="text-body-sm text-muted-foreground">{block.detail}</p>
      <p className="mt-1 text-body-sm">
        {t`Maximum cost`} {formatRupees(block.maxCostPaise)}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" onClick={() => onChoose(block.actionId, "approve")}>
          {t`Approve this offer`}
        </Button>
        <button
          type="button"
          className="text-body-sm text-primary"
          onClick={() => onChoose(block.actionId, "change")}
        >
          {t`Change it`}
        </button>
        <button
          type="button"
          className="text-body-sm text-muted-foreground"
          onClick={() => onChoose(block.actionId, "not_now")}
        >
          {t`Not now`}
        </button>
      </div>
    </div>
  );
}
