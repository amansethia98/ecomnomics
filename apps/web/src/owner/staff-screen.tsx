import { useLingui } from "@lingui/react/macro";
import type { StaffBlock, StaffChoiceBlock, StaffMessage, StaffThread } from "@rakazo/contracts";
import { formatRupees, formatSignedPct, STAFF_QUESTION_LIMIT } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
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
  onAsk: (text: string) => void;
  onChoose: (actionId: string, choice: "approve" | "change" | "not_now") => void;
}) {
  const { t } = useLingui();
  const [text, setText] = useState("");
  const disabled = thread.quota.inputDisabled;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {thread.greeting ? <p className="text-heading3 font-medium">{thread.greeting}</p> : null}
      {thread.messages.map((message, index) => (
        <div key={message.id}>
          {index === 0 || thread.messages[index - 1]?.date !== message.date ? (
            <p className="text-label text-muted-foreground">{message.date}</p>
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
              className="text-body-sm text-primary"
              onClick={() => onAsk(starter)}
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
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const next = text.trim();
          if (!next || disabled) return;
          setText("");
          onAsk(next);
        }}
      >
        <input
          aria-label={t`Question`}
          className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-body"
          disabled={disabled}
          value={text}
          placeholder={disabled ? t`You've used today's 30 questions. Resets at midnight.` : t`Ask`}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" disabled={disabled || text.trim().length === 0}>
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
  return (
    <div className={message.role === "owner" ? "mt-2 text-right" : "mt-2"}>
      {message.blocks.map((block, index) => (
        <Block
          key={`${message.id}-${index}`}
          block={block}
          restaurantId={restaurantId}
          onChoose={onChoose}
        />
      ))}
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
  if (block.kind === "text") return <p className="mt-2">{block.text}</p>;
  if (block.kind === "metric") {
    return (
      <div className="mt-3">
        <p className="text-label text-muted-foreground">{block.label}</p>
        <p className="text-heading3 font-medium">
          {block.paise != null ? formatRupees(block.paise) : t`Not in yet`}
        </p>
        {block.changePct != null && block.compare ? (
          <ChangeBadge
            direction={block.changePct < 0 ? "down" : "up"}
            label={`${formatSignedPct(block.changePct)} vs ${block.compare}`}
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
