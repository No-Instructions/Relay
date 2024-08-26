// Adapted from https://github.com/friebetill/obsidian-file-diff
//
// MIT License
//
// Copyright (c) 2022 Till Friebe
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

export class Difference {
	constructor(args: {
		file1Start: number;
		file2Start: number;
		file1Lines: string[];
		file2Lines: string[];
	}) {
		this.file1Start = args.file1Start;
		this.file2Start = args.file2Start;
		this.file1Lines = args.file1Lines;
		this.file2Lines = args.file2Lines;
	}

	public readonly file1Start: number;
	public readonly file2Start: number;
	public readonly file1Lines: string[];
	public readonly file2Lines: string[];
}
