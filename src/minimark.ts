/**
 * minimark - A minimal markdown parser that supports only bold and emphasis (as underline)
 * * = emphasis/underline (rendered as <u>)
 * ** = bold (rendered as <strong>)
 */

enum TokenType {
	TEXT = "TEXT",
	STAR = "STAR",
	DOUBLE_STAR = "DOUBLE_STAR",
}

enum State {
	NORMAL = "NORMAL",
	EMPHASIS = "EMPHASIS",
	BOLD = "BOLD",
}

interface Token {
	type: TokenType;
	value?: string;
}

function tokenize(input: string) {
	const tokens = [];
	let currentText = "";

	let i = 0;
	while (i < input.length) {
		// Check for double star
		if (input[i] === "*" && i + 1 < input.length && input[i + 1] === "*") {
			// Save any accumulated text
			if (currentText) {
				tokens.push({ type: TokenType.TEXT, value: currentText });
				currentText = "";
			}
			tokens.push({ type: TokenType.DOUBLE_STAR });
			i += 2; // Skip both stars
		}
		// Check for single star
		else if (input[i] === "*") {
			// Save any accumulated text
			if (currentText) {
				tokens.push({ type: TokenType.TEXT, value: currentText });
				currentText = "";
			}
			tokens.push({ type: TokenType.STAR });
			i++;
		}
		// Regular text
		else {
			currentText += input[i];
			i++;
		}
	}

	// Don't forget any remaining text
	if (currentText) {
		tokens.push({ type: TokenType.TEXT, value: currentText });
	}

	return tokens;
}

function parse(tokens: Token[]): string {
	let html = "";
	let state = State.NORMAL;
	let i = 0;

	while (i < tokens.length) {
		const token = tokens[i];

		switch (state) {
			case State.NORMAL:
				if (token.type === TokenType.TEXT) {
					html += token.value;
				} else if (token.type === TokenType.STAR) {
					state = State.EMPHASIS;
					html += "<u>";
				} else if (token.type === TokenType.DOUBLE_STAR) {
					state = State.BOLD;
					html += "<strong>";
				}
				break;

			case State.EMPHASIS:
				if (token.type === TokenType.TEXT) {
					html += token.value;
				} else if (token.type === TokenType.STAR) {
					state = State.NORMAL;
					html += "</u>";
				} else if (token.type === TokenType.DOUBLE_STAR) {
					// Handle edge case: we're in emphasis and found a double star
					// Close the emphasis and open a bold
					state = State.BOLD;
					html += "</u><strong>";
				}
				break;

			case State.BOLD:
				if (token.type === TokenType.TEXT) {
					html += token.value;
				} else if (token.type === TokenType.STAR) {
					// Handle edge case: we're in bold and found a single star
					// This is likely an error, but we'll handle it by treating it as text
					html += "*";
				} else if (token.type === TokenType.DOUBLE_STAR) {
					state = State.NORMAL;
					html += "</strong>";
				}
				break;
		}

		i++;
	}

	// Handle unclosed tags
	if (state === State.EMPHASIS) {
		html += "</u>";
	} else if (state === State.BOLD) {
		html += "</strong>";
	}

	return html;
}

export function minimark(markdown: string): string {
	// minimark's main conversion function
	const tokens = tokenize(markdown);
	return parse(tokens);
}
