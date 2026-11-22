import { cn } from "@rakazo/ui-web/lib/utils";
import type { DayPickerProps } from "react-day-picker";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";

/** shadcn calendar. One month on a phone, two when the caller asks. */
export function Calendar({ className, ...props }: DayPickerProps) {
  return <DayPicker className={cn("p-2 text-body-sm", className)} {...props} />;
}
