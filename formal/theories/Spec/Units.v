From Coq Require Import ZArith String Ascii Bool DecimalString Lia.
From DEXFormal.Spec Require Import Types.

Open Scope Z_scope.
Open Scope string_scope.

Definition decimal_digit (character : ascii) : option Z :=
  let code := nat_of_ascii character in
  if (Nat.leb 48 code && Nat.leb code 57)%bool
  then Some (Z.of_nat (code - 48)) else None.

Fixpoint parse_digits (text : string) : option Z :=
  match text with
  | EmptyString => Some 0
  | String character rest =>
      match decimal_digit character, parse_digits rest with
      | Some digit, Some value =>
          Some (digit * 10 ^ Z.of_nat (String.length rest) + value)
      | _, _ => None
      end
  end.

Inductive decimal_digits : string -> Z -> Prop :=
| DigitsEmpty : decimal_digits EmptyString 0
| DigitsMore character rest digit value :
    decimal_digit character = Some digit -> decimal_digits rest value ->
    decimal_digits (String character rest)
      (digit * 10 ^ Z.of_nat (String.length rest) + value).

Lemma parse_digits_sound text value :
  parse_digits text = Some value -> decimal_digits text value.
Proof.
  revert value. induction text as [|character rest IH]; intros value H.
  - inversion H. constructor.
  - simpl in H. destruct (decimal_digit character) eqn:Hd; try discriminate.
    destruct (parse_digits rest) eqn:Hr; try discriminate.
    inversion H; subst. constructor; auto.
Qed.

Fixpoint split_decimal (text : string) : string * option string :=
  match text with
  | EmptyString => (EmptyString, None)
  | String character rest =>
      if Ascii.eqb character "."%char then (EmptyString, Some rest)
      else let '(whole, fraction) := split_decimal rest in
        (String character whole, fraction)
  end.

Definition checked_uint (value : Z) : option Z :=
  if uint256b value then Some value else None.

Lemma checked_uint_sound value result :
  checked_uint value = Some result -> result = value /\ uint256 result.
Proof.
  unfold checked_uint. destruct (uint256b value) eqn:H; try discriminate.
  intros E. inversion E; subst. split; auto. now apply uint256b_spec.
Qed.

Fixpoint within_length (fuel : nat) (text : string) : bool :=
  match text, fuel with
  | EmptyString, _ => true
  | String _ _, O => false
  | String _ rest, S remaining => within_length remaining rest
  end.

Definition parse_decimal (places : nat) (text : string) : option Z :=
  (* DEFENSE: These are user-entered strings; bound recursive decimal work before parsing.
     KNOWN LIMITATION: Text longer than 100 plus its precision is rejected, including redundant padding. *)
  if negb (within_length (100 + places) text) then None else
  let '(whole, fraction) := split_decimal text in
  if String.eqb whole EmptyString then None
  else match parse_digits whole with
  | None => None
  | Some integer =>
      match fraction with
      | None => checked_uint (integer * 10 ^ Z.of_nat places)
      | Some digits =>
          if Nat.leb (String.length digits) places then
            match parse_digits digits with
            | None => None
            | Some fractional => checked_uint
                (integer * 10 ^ Z.of_nat places +
                 fractional * 10 ^ Z.of_nat (places - String.length digits))
            end
          else None
      end
  end.

Definition decimal_represents (places : nat) (text : string) (value : Z) : Prop :=
  exists whole fraction integer,
    split_decimal text = (whole, fraction) /\ whole <> EmptyString /\
    decimal_digits whole integer /\
    match fraction with
    | None => value = integer * 10 ^ Z.of_nat places
    | Some digits => exists fractional,
        decimal_digits digits fractional /\
        (String.length digits <= places)%nat /\
        value = integer * 10 ^ Z.of_nat places +
          fractional * 10 ^ Z.of_nat (places - String.length digits)
    end.

Theorem parse_decimal_sound places text value :
  parse_decimal places text = Some value ->
  decimal_represents places text value /\ uint256 value.
Proof.
  unfold parse_decimal.
  destruct (negb (within_length (100 + places) text)); try discriminate.
  destruct (split_decimal text) as [whole fraction] eqn:Hsplit.
  destruct (String.eqb whole EmptyString) eqn:Hempty; try discriminate.
  destruct (parse_digits whole) as [integer|] eqn:Hwhole; try discriminate.
  destruct fraction as [digits|].
  - destruct (Nat.leb (String.length digits) places) eqn:Hlength; try discriminate.
    destruct (parse_digits digits) as [fractional|] eqn:Hfraction; try discriminate.
    intro H. apply checked_uint_sound in H as [E Hbound].
    split; [|exact Hbound].
    exists whole, (Some digits), integer. repeat split; auto.
    + now apply String.eqb_neq in Hempty.
    + now apply parse_digits_sound.
    + exists fractional. repeat split; auto.
      * now apply parse_digits_sound.
      * now apply Nat.leb_le.
  - intro H. apply checked_uint_sound in H as [E Hbound].
    split; [|exact Hbound].
    exists whole, None, integer. repeat split; auto.
    + now apply String.eqb_neq in Hempty.
    + now apply parse_digits_sound.
Qed.

Definition ascii_space (character : ascii) : bool :=
  let code := nat_of_ascii character in
  (Nat.eqb code 32 || Nat.eqb code 9 || Nat.eqb code 10 || Nat.eqb code 13)%bool.

Fixpoint trim_left (text : string) : string :=
  match text with
  | EmptyString => EmptyString
  | String character rest => if ascii_space character then trim_left rest else text
  end.

Fixpoint reverse_into (text reversed : string) : string :=
  match text with
  | EmptyString => reversed
  | String character rest => reverse_into rest (String character reversed)
  end.

Definition trim (text : string) : string :=
  reverse_into (trim_left (reverse_into (trim_left text) EmptyString)) EmptyString.

Open Scope Z_scope.

Definition valid_precision (places : Z) := (0 <=? places) && (places <=? 255).
Definition parse_units (places : Z) (text : string) : option Z :=
  (* DEFENSE: decimals is a uint8 metadata observation; bound external text before trimming. *)
  if valid_precision places && within_length (100 + Z.to_nat places) text
  then parse_decimal (Z.to_nat places) (trim text) else None.
Definition positive_units places text : option Z :=
  match parse_units places text with
  | Some value => if Z.ltb 0 value then Some value else None
  | None => None
  end.
Theorem positive_units_sound places text value :
  positive_units places text = Some value ->
  0 < value /\ uint256 value /\ decimal_represents (Z.to_nat places) (trim text) value.
Proof.
  unfold positive_units, parse_units.
  destruct (valid_precision places && within_length (100 + Z.to_nat places) text); try discriminate.
  destruct (parse_decimal (Z.to_nat places) (trim text)) as [parsed|] eqn:H; try discriminate.
  destruct (Z.ltb 0 parsed) eqn:Hpositive; try discriminate.
  intro E. inversion E; subst. apply parse_decimal_sound in H as [Hmeaning Hbound].
  apply Z.ltb_lt in Hpositive. auto.
Qed.
Definition parse_units_18 := parse_units 18.
Definition empty_amount (text : string) : bool :=
  if within_length 100 text then String.eqb (trim text) EmptyString else false.
Definition positive_units_18 (text : string) : option Z :=
  match parse_units_18 text with
  | Some value => if Z.ltb 0 value then Some value else None
  | None => None
  end.
Definition parse_slippage_bps (text : string) : option Z :=
  match parse_decimal 2 text with
  | Some value => if Z.leb value 5000 then Some value else None
  | None => None
  end.

Theorem positive_units_18_sound text value :
  positive_units_18 text = Some value ->
  0 < value /\ uint256 value /\ decimal_represents 18 (trim text) value.
Proof. apply positive_units_sound. Qed.

Theorem parse_slippage_bps_sound text value :
  parse_slippage_bps text = Some value -> 0 <= value <= 5000.
Proof.
  unfold parse_slippage_bps.
  destruct (parse_decimal 2 text) as [parsed|] eqn:H; try discriminate.
  destruct (Z.leb parsed 5000) eqn:Hmax; try discriminate.
  intro E. inversion E; subst. apply Z.leb_le in Hmax.
  apply parse_decimal_sound in H as [_ [Hnonnegative _]]. lia.
Qed.

Definition integer_text (value : Z) : string :=
  DecimalString.NilZero.string_of_int (Z.to_int value).

Fixpoint zeroes (count : nat) : string :=
  match count with O => EmptyString | S rest => String "0"%char (zeroes rest) end.

Fixpoint remove_leading_zeroes (text : string) : string :=
  match text with
  | EmptyString => EmptyString
  | String character rest =>
      if Ascii.eqb character "0"%char then remove_leading_zeroes rest else text
  end.

Definition remove_trailing_zeroes text :=
  reverse_into (remove_leading_zeroes (reverse_into text EmptyString)) EmptyString.

Definition format_scaled_unsigned (places : nat) (value : Z) : string :=
  let denominator := 10 ^ Z.of_nat places in
  let whole := integer_text (value / denominator) in
  let remainder := value mod denominator in
  if Z.eqb remainder 0 then whole
  else let fractional := integer_text remainder in
    whole ++ "." ++ remove_trailing_zeroes
      (zeroes (places - String.length fractional) ++ fractional).

Definition format_scaled places value : string :=
  if Z.ltb value 0 then "-" ++ format_scaled_unsigned places (- value)
  else format_scaled_unsigned places value.
Definition format_units_18 := format_scaled 18.

Definition amount_error places text (balance : option Z) : option string :=
  match positive_units places text with
  | None => Some "Enter a positive uint256 amount within the token decimal precision."
  | Some amount => match balance with
      | None => None
      | Some available => if Z.leb amount available then None
          else Some "Amount exceeds the available token balance."
      end
  end.

Definition slippage_error text : option string :=
  match parse_slippage_bps text with
  | Some _ => None
  | None => Some "Slippage must be between 0% and 50%, with at most two decimal places."
  end.

Definition format_units (places : Z) (value : Z) : option string :=
  if valid_precision places then Some (format_scaled (Z.to_nat places) value) else None.
Definition scaled_price numerator numerator_places denominator denominator_places :=
  numerator * 10 ^ denominator_places * 10 ^ 8 / (denominator * 10 ^ numerator_places).
Definition price_text numerator numerator_places denominator denominator_places : option string :=
  if valid_precision numerator_places && valid_precision denominator_places &&
      (0 <? numerator) && (0 <? denominator) then
    let value := scaled_price numerator numerator_places denominator denominator_places in
    Some (if value =? 0 then "<0.00000001" else format_scaled 8 value)
  else None.
Theorem accepted_precision_is_uint8 places text value :
  parse_units places text = Some value -> 0 <= places <= 255.
Proof.
  unfold parse_units,valid_precision. destruct ((0 <=? places) && (places <=? 255) && _)%bool eqn:E; try discriminate.
  apply andb_true_iff in E as [E _]. apply andb_true_iff in E as [A B].
  apply Z.leb_le in A. apply Z.leb_le in B. lia.
Qed.
Theorem equal_human_units_have_unit_price places :
  0 <= places -> scaled_price (10 ^ places) places (10 ^ 18) 18 = 10 ^ 8.
Proof.
  intros H. unfold scaled_price. assert (0 < 10 ^ places) by (apply Z.pow_pos_nonneg;lia).
  assert (10 ^ 18 * 10 ^ places <> 0) by nia.
  replace (10 ^ places * 10 ^ 18 * 10 ^ 8) with ((10 ^ 8) * (10 ^ 18 * 10 ^ places)) by ring.
  apply Z.div_mul. assumption.
Qed.

Definition compact_units (places digits value : Z) : option string :=
  if valid_precision places && valid_precision digits then
    let visible := Z.min places digits in
    let scale := 10 ^ (places - visible) in
    let magnitude := Z.abs value in
    let text := if (0 <? magnitude) && (magnitude <? scale)
      then (if value <? 0 then ">-" else "<") ++ format_scaled (Z.to_nat places) scale
      else format_scaled (Z.to_nat visible) (value / scale) in Some text
  else None.
