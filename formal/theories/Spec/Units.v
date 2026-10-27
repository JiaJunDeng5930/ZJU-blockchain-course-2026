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
     KNOWN LIMITATION: Redundant leading-zero padding beyond 100 characters is rejected. *)
  if negb (within_length 100 text) then None else
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
  destruct (negb (within_length 100 text)); try discriminate.
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

Definition parse_units_18 (text : string) : option Z :=
  (* DEFENSE: Bound external text before whitespace trimming also traverses it. *)
  if within_length 100 text then parse_decimal 18 (trim text) else None.
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
Proof.
  unfold positive_units_18, parse_units_18.
  destruct (within_length 100 text); try discriminate.
  destruct (parse_decimal 18 (trim text)) as [parsed|] eqn:H; try discriminate.
  destruct (Z.ltb 0 parsed) eqn:Hpositive; try discriminate.
  intro E. inversion E; subst. apply parse_decimal_sound in H as [Hmeaning Hbound].
  apply Z.ltb_lt in Hpositive. auto.
Qed.

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

Definition amount_error text (balance : option Z) : option string :=
  match positive_units_18 text with
  | None => Some "Enter a positive uint256 amount with at most 18 decimal places."
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
