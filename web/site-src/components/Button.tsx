/**
 * Button — headless themed button. Renders <a> when `href` is given, else <button>.
 * Style via [data-part="button"] (+ data-variant / data-size) in base.ts.
 */
import type { ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode } from "react";

type Variant = "default" | "primary" | "ghost";
type Size = "md" | "sm";

interface CommonProps {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

type ButtonProps = CommonProps &
  ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };
type LinkProps = CommonProps &
  AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

export function Button(props: ButtonProps | LinkProps) {
  const { variant = "default", size = "md", children, ...rest } = props as
    & CommonProps
    & Record<string, unknown>;
  const data = {
    "data-part": "button",
    "data-variant": variant,
    "data-size": size,
  };
  if ("href" in props && props.href !== undefined) {
    return (
      <a {...data} {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" {...data} {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}>
      {children}
    </button>
  );
}
