/**
 * Question kinds (spec sections 4, 12).
 * Free-text/essay questions use DESCRIPTIVE;
 * their answers live on response.text_answer + correction rows.
 */
export enum QuestionType {
  MULTIPLE_CHOICE = 'multiple_choice',
  TRUE_FALSE = 'true_false',
  FILL_BLANK = 'fill_blank',
  DESCRIPTIVE = 'descriptive',
  MULTI_PART = 'multi_part',
}
