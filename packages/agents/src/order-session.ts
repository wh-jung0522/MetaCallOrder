import type { Cart, CartItem, MenuItem } from "@callorder/adapters";
import { countToKorean, isAffirmative, isNegative, wonToKorean, type Language } from "./text";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function cartHash(cart: Cart): Promise<string> {
  const lines = cart.items
    .map((line) => [line.menu_item_id, line.quantity, Object.entries(line.options).sort()])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return sha256(JSON.stringify([cart.store_id, lines]));
}

export function buildRecap(storeName: string, cart: Cart, total: number, address: string, language: Language = "ko"): string {
  if (language === "en") {
    const lines = cart.items.map((line) => `${line.quantity} ${line.label_en ?? line.name}`);
    return `From ${storeName}, ${lines.join(", ")}, ${total.toLocaleString("en-US")} won including delivery, to ${address}. Shall I place this order? Please say yes to confirm.`;
  }
  const lines = cart.items.map((line) => {
    const options = Object.values(line.options).join(" ");
    return `${options ? `${options} ` : ""}${line.name} ${countToKorean(line.quantity)} 개`;
  });
  return `${storeName}에서 ${lines.join(", ")}, 배달비 포함 ${wonToKorean(total)}, ${address}로 보내드릴까요? 맞으면 네, 라고 말씀해 주세요.`;
}

interface Confirmation {
  token: string;
  cartHash: string;
  recap: string;
  confirmed: boolean;
}

export type ConfirmationOutcome = "confirmed" | "rejected" | "none";

// Whether an order may be placed is decided here, by code, from what was said aloud. The LLM has no way in.
export class OrderSession {
  cart: Cart | null = null;
  language: Language = "ko";
  private confirmation: Confirmation | null = null;
  private lastSpoken: string | null = null;

  addItem(item: MenuItem, quantity: number, options: Record<string, string>): void {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw new Error("수량은 1에서 50 사이여야 합니다");
    if (this.cart && this.cart.store_id !== item.store_id && this.cart.items.length) {
      throw new Error("한 주문에는 한 가게의 메뉴만 담을 수 있습니다");
    }
    for (const option of item.options) {
      const chosen = options[option.name];
      if (chosen === undefined && option.required) throw new Error(`옵션을 먼저 여쭤보세요: ${option.name} (${option.choices.join(", ")})`);
      if (chosen !== undefined && !option.choices.includes(chosen)) throw new Error(`${option.name} 옵션은 ${option.choices.join(", ")} 중 하나여야 합니다`);
    }
    const optionsEn = item.options.flatMap((option) => {
      const chosen = options[option.name];
      if (chosen === undefined) return [];
      return [option.choices_en?.[option.choices.indexOf(chosen)] ?? chosen];
    });
    const label_en = [...optionsEn, item.name_en ?? item.name].join(" ");
    const line: CartItem = { menu_item_id: item.id, name: item.name, label_en, quantity, unit_price: item.price, options };
    if (!this.cart || this.cart.store_id !== item.store_id) this.cart = { store_id: item.store_id, items: [] };
    const same = this.cart.items.find(
      (existing) => existing.menu_item_id === item.id && JSON.stringify(existing.options) === JSON.stringify(options),
    );
    if (same) same.quantity += quantity;
    else this.cart.items.push(line);
    this.confirmation = null;
  }

  removeItem(menuItemId: string): void {
    if (!this.cart) return;
    this.cart.items = this.cart.items.filter((line) => line.menu_item_id !== menuItemId);
    this.confirmation = null;
  }

  async issueConfirmation(recap: string): Promise<string> {
    if (!this.cart?.items.length) throw new Error("장바구니가 비어 있습니다");
    this.confirmation = { token: crypto.randomUUID(), cartHash: await cartHash(this.cart), recap, confirmed: false };
    return this.confirmation.token;
  }

  // Call with every utterance actually sent to the caller, in order.
  noteSpoken(text: string): void {
    this.lastSpoken = text;
  }

  // The caller cut the recap off, so they have not heard the full order.
  noteInterrupted(): void {
    this.lastSpoken = null;
  }

  noteCallerUtterance(text: string): ConfirmationOutcome {
    const pending = this.confirmation;
    if (!pending || pending.confirmed || this.lastSpoken !== pending.recap) return "none";
    if (isNegative(text)) {
      this.confirmation = null;
      return "rejected";
    }
    if (!isAffirmative(text)) return "none";
    pending.confirmed = true;
    return "confirmed";
  }

  get status(): { token: string; confirmed: boolean } | null {
    return this.confirmation && { token: this.confirmation.token, confirmed: this.confirmation.confirmed };
  }

  // Returns the idempotency hash when the order may proceed, and throws otherwise.
  async assertConfirmed(token: string): Promise<string> {
    if (!this.cart?.items.length) throw new Error("장바구니가 비어 있습니다");
    if (!this.confirmation || this.confirmation.token !== token) throw new Error("확인 토큰이 없습니다. 먼저 복창하세요");
    if (!this.confirmation.confirmed) throw new Error("고객이 아직 '네'라고 확인하지 않았습니다");
    const hash = await cartHash(this.cart);
    if (hash !== this.confirmation.cartHash) throw new Error("복창 후 장바구니가 바뀌었습니다. 다시 복창하세요");
    return hash;
  }
}
