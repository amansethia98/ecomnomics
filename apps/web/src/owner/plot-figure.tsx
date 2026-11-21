import { useLingui } from "@lingui/react/macro";
import type { OwnerPlot } from "@rakazo/contracts";
import { resolveOwnerPlot } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";

/** Renders one Observable Plot spec. The markup is parsed, not injected as HTML. */
export function PlotFigure({ plot }: { plot: OwnerPlot }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const key = JSON.stringify(plot);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let live = true;
    void import("@rakazo/core/plot").then(({ renderPlotSpecToSvg }) => {
      if (!live || !host.current) return;
      host.current.replaceChildren();
      try {
        const markup = renderPlotSpecToSvg(resolveOwnerPlot(plot), undefined, document);
        const svg = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
        if (svg.nodeName.toLowerCase() !== "svg") {
          console.error("owner plot did not return an svg", plot.id);
          setFailed(true);
          return;
        }
        host.current.append(svg);
        setFailed(false);
      } catch (error) {
        console.error(error);
        host.current.replaceChildren();
        setFailed(true);
      }
    });
    return () => {
      live = false;
    };
  }, [key, plot]);
  return (
    <div>
      <div ref={host} className="owner-plot" />
      {failed ? <PlotFallback plot={plot} /> : null}
    </div>
  );
}

function PlotFallback({ plot }: { plot: OwnerPlot }) {
  const { t } = useLingui();
  const mark = plot.marks.find((item) => {
    const x = item.options?.x;
    const y = item.options?.y;
    return typeof x === "string" && typeof y === "string" && (item.data?.length ?? 0) > 0;
  });
  const rows = mark?.data?.filter(
    (row): row is Record<string, unknown> => !!row && typeof row === "object",
  );
  const x = typeof mark?.options?.x === "string" ? mark.options.x : null;
  const y = typeof mark?.options?.y === "string" ? mark.options.y : null;
  if (!rows || rows.length === 0 || !x || !y) {
    return <p className="text-body-sm text-muted-foreground">{t`Not in yet`}</p>;
  }
  return (
    <table className="text-body-sm text-muted-foreground">
      <tbody>
        {rows.map((row) => (
          <tr key={String(row[x])}>
            <td className="pr-4">{String(row[x])}</td>
            <td>{String(row[y])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
