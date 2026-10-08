/* Campaign Manager: the visual email builder's block model. Every block renders to inline-styled, table-based
 * HTML (what email clients need) and the same output is what the canvas shows and what is saved and sent. */
(() => {
	const CM = window.CM
	const esc = CM.escape
	const FONTS = {
		Arial: 'Arial, Helvetica, sans-serif', Georgia: 'Georgia, "Times New Roman", serif', Verdana: 'Verdana, Geneva, sans-serif',
		'Trebuchet MS': '"Trebuchet MS", Helvetica, sans-serif', Tahoma: 'Tahoma, Geneva, sans-serif', 'Courier New': '"Courier New", monospace',
	}
	const ALIGN = [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]
	const lines = (t) => esc(t).replace(/\r?\n/g, '<br>')
	const url = (u) => esc(u || '#')
	const absolute = (u) => (u && u.startsWith('/') ? location.origin + u : u)

	/** Block catalogue: label, icon, defaults, property schema and renderer (returns one <tr>). */
	const T = (CM.BLOCKS = {
		heading: {
			label: 'Heading', icon: 'heading', group: 'Content',
			make: () => ({ text: 'Hello {{ first_name }}', level: 'h1', align: 'left', color: '#14161a' }),
			schema: [{ key: 'text', label: 'Text', type: 'text', vars: true }, { key: 'level', label: 'Size', type: 'select', options: [{ value: 'h1', label: 'Large' }, { value: 'h2', label: 'Medium' }, { value: 'h3', label: 'Small' }] }, { key: 'align', label: 'Alignment', type: 'select', options: ALIGN }, { key: 'color', label: 'Colour', type: 'color' }],
			html: (p, s) => { const size = { h1: 28, h2: 22, h3: 18 }[p.level] || 28; return `<tr><td align="${p.align}" style="padding:12px 32px 4px;font-family:${FONTS[s.font]};font-size:${size}px;line-height:1.3;font-weight:700;color:${esc(p.color)};text-align:${p.align}">${esc(p.text)}</td></tr>` },
		},
		text: {
			label: 'Text', icon: 'text', group: 'Content',
			make: () => ({ text: 'Thank you for your interest. Write your message here and add personal touches with variables like {{ first_name }}.', align: 'left', color: '#3b4252', size: 15 }),
			schema: [{ key: 'text', label: 'Text', type: 'textarea', vars: true }, { key: 'align', label: 'Alignment', type: 'select', options: ALIGN }, { key: 'size', label: 'Font size (px)', type: 'number', min: 11, max: 28 }, { key: 'color', label: 'Colour', type: 'color' }],
			html: (p, s) => `<tr><td align="${p.align}" style="padding:8px 32px;font-family:${FONTS[s.font]};font-size:${+p.size || 15}px;line-height:1.65;color:${esc(p.color)};text-align:${p.align}">${lines(p.text)}</td></tr>`,
		},
		image: {
			label: 'Image', icon: 'image', group: 'Content',
			make: () => ({ src: '', alt: '', link: '', width: 100, align: 'center', radius: 8 }),
			schema: [{ key: 'src', label: 'Image', type: 'image' }, { key: 'alt', label: 'Alt text', type: 'text' }, { key: 'link', label: 'Link (optional)', type: 'text', placeholder: 'https://' }, { key: 'width', label: 'Width (%)', type: 'number', min: 10, max: 100 }, { key: 'align', label: 'Alignment', type: 'select', options: ALIGN }, { key: 'radius', label: 'Rounded corners (px)', type: 'number', min: 0, max: 40 }],
			html: (p) => {
				const img = p.src
					? `<img src="${esc(absolute(p.src))}" alt="${esc(p.alt)}" width="${Math.round(536 * ((+p.width || 100) / 100))}" style="display:block;width:${+p.width || 100}%;max-width:100%;height:auto;border:0;border-radius:${+p.radius || 0}px">`
					: `<div style="padding:40px 12px;text-align:center;background:#f1f3f6;color:#8b93a1;font:13px Arial,sans-serif;border-radius:${+p.radius || 0}px">Choose an image</div>`
				return `<tr><td align="${p.align}" style="padding:8px 32px;text-align:${p.align}">${p.link && p.src ? `<a href="${url(p.link)}" target="_blank">${img}</a>` : img}</td></tr>`
			},
		},
		button: {
			label: 'Button', icon: 'zap', group: 'Content',
			make: () => ({ label: 'Book a counselling call', url: 'https://', bg: '#2563eb', color: '#ffffff', radius: 8, align: 'center', full: false }),
			schema: [{ key: 'label', label: 'Label', type: 'text', vars: true }, { key: 'url', label: 'Link', type: 'text', placeholder: 'https://', vars: true }, { key: 'bg', label: 'Button colour', type: 'color' }, { key: 'color', label: 'Text colour', type: 'color' }, { key: 'radius', label: 'Rounded corners (px)', type: 'number', min: 0, max: 40 }, { key: 'align', label: 'Alignment', type: 'select', options: ALIGN }, { key: 'full', label: 'Full width', type: 'switch' }],
			html: (p, s) => `<tr><td align="${p.align}" style="padding:14px 32px"><table role="presentation" cellpadding="0" cellspacing="0" ${p.full ? 'width="100%"' : ''} style="${p.full ? 'width:100%;' : ''}border-collapse:separate"><tr><td align="center" bgcolor="${esc(p.bg)}" style="background-color:${esc(p.bg)};border-radius:${+p.radius || 0}px"><a href="${url(p.url)}" target="_blank" style="display:inline-block;padding:13px 28px;font-family:${FONTS[s.font]};font-size:15px;font-weight:700;line-height:1.2;color:${esc(p.color)};text-decoration:none;border-radius:${+p.radius || 0}px">${esc(p.label)}</a></td></tr></table></td></tr>`,
		},
		divider: {
			label: 'Divider', icon: 'minus', group: 'Layout',
			make: () => ({ color: '#e3e6eb', thickness: 1, space: 12 }),
			schema: [{ key: 'color', label: 'Colour', type: 'color' }, { key: 'thickness', label: 'Thickness (px)', type: 'number', min: 1, max: 8 }, { key: 'space', label: 'Space above and below (px)', type: 'number', min: 0, max: 60 }],
			html: (p) => `<tr><td style="padding:${+p.space || 0}px 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td height="${+p.thickness || 1}" style="height:${+p.thickness || 1}px;line-height:${+p.thickness || 1}px;font-size:0;background-color:${esc(p.color)}">&nbsp;</td></tr></table></td></tr>`,
		},
		spacer: {
			label: 'Spacer', icon: 'spacer', group: 'Layout',
			make: () => ({ height: 24 }),
			schema: [{ key: 'height', label: 'Height (px)', type: 'number', min: 4, max: 120 }],
			html: (p) => `<tr><td height="${+p.height || 24}" style="height:${+p.height || 24}px;line-height:${+p.height || 24}px;font-size:0">&nbsp;</td></tr>`,
		},
		columns: {
			label: 'Columns', icon: 'columns', group: 'Layout',
			make: () => ({ count: 2, cols: [{ heading: 'Flexible fees', text: 'Pay in easy instalments.' }, { heading: 'Industry mentors', text: 'Learn from working leaders.' }, { heading: 'Placement help', text: 'Resume and interview support.' }], align: 'left' }),
			schema: [{ key: 'count', label: 'Columns', type: 'select', options: [{ value: 2, label: '2 columns' }, { value: 3, label: '3 columns' }] }, { key: 'cols', type: 'cols' }],
			html: (p, s) => {
				const n = +p.count === 3 ? 3 : 2; const w = n === 3 ? 170 : 262
				const cells = p.cols.slice(0, n).map((c) => `<div style="display:inline-block;width:100%;max-width:${w}px;vertical-align:top"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:8px 8px;font-family:${FONTS[s.font]};text-align:${p.align}"><div style="font-size:16px;font-weight:700;color:#14161a;margin-bottom:4px">${esc(c.heading)}</div><div style="font-size:14px;line-height:1.55;color:#4b5563">${lines(c.text)}</div></td></tr></table></div>`).join('')
				return `<tr><td align="center" style="padding:8px 24px;font-size:0">${cells}</td></tr>`
			},
		},
		banner: {
			label: 'Banner', icon: 'banner', group: 'Content',
			make: () => ({ title: 'Admissions are open', subtitle: 'Reserve your seat for the next batch.', bg: '#2563eb', color: '#ffffff', button: 'Apply now', url: 'https://', align: 'center' }),
			schema: [{ key: 'title', label: 'Title', type: 'text', vars: true }, { key: 'subtitle', label: 'Subtitle', type: 'textarea', vars: true }, { key: 'bg', label: 'Background colour', type: 'color' }, { key: 'color', label: 'Text colour', type: 'color' }, { key: 'button', label: 'Button label (optional)', type: 'text' }, { key: 'url', label: 'Button link', type: 'text', placeholder: 'https://' }, { key: 'align', label: 'Alignment', type: 'select', options: ALIGN }],
			html: (p, s) => `<tr><td align="${p.align}" bgcolor="${esc(p.bg)}" style="background-color:${esc(p.bg)};padding:36px 32px;font-family:${FONTS[s.font]};text-align:${p.align};color:${esc(p.color)}"><div style="font-size:26px;line-height:1.25;font-weight:700;margin:0 0 8px">${esc(p.title)}</div><div style="font-size:15px;line-height:1.55;opacity:.92">${lines(p.subtitle)}</div>${p.button ? `<table role="presentation" cellpadding="0" cellspacing="0" align="${p.align}" style="margin-top:18px"><tr><td align="center" bgcolor="${esc(p.color)}" style="background-color:${esc(p.color)};border-radius:8px"><a href="${url(p.url)}" target="_blank" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:700;color:${esc(p.bg)};text-decoration:none">${esc(p.button)}</a></td></tr></table>` : ''}</td></tr>`,
		},
		social: {
			label: 'Social links', icon: 'share', group: 'Layout',
			make: () => ({ align: 'center', links: [{ network: 'Instagram', url: 'https://instagram.com/' }, { network: 'LinkedIn', url: 'https://linkedin.com/' }, { network: 'YouTube', url: 'https://youtube.com/' }] }),
			schema: [{ key: 'align', label: 'Alignment', type: 'select', options: ALIGN }, { key: 'links', type: 'links' }],
			html: (p, s) => {
				const col = { Facebook: '#1877f2', Instagram: '#d6249f', LinkedIn: '#0a66c2', YouTube: '#e11d1d', X: '#14161a', WhatsApp: '#128c4a', Website: '#475569' }
				return `<tr><td align="${p.align}" style="padding:10px 32px;text-align:${p.align}">${p.links.filter((l) => l.network).map((l) => `<a href="${url(l.url)}" target="_blank" style="display:inline-block;margin:3px 4px;padding:6px 12px;border-radius:99px;background-color:${col[l.network] || '#475569'};color:#ffffff;font-family:${FONTS[s.font]};font-size:12.5px;font-weight:700;text-decoration:none">${esc(l.network)}</a>`).join('')}</td></tr>`
			},
		},
		footer: {
			label: 'Footer', icon: 'flag', group: 'Layout',
			make: () => ({ text: 'Your company name, Street address, City\nYou are receiving this email because you enquired with us.', align: 'center', color: '#8b93a1' }),
			schema: [{ key: 'text', label: 'Footer text', type: 'textarea', vars: true, hint: 'An unsubscribe link is added under every campaign email automatically.' }, { key: 'align', label: 'Alignment', type: 'select', options: ALIGN }, { key: 'color', label: 'Colour', type: 'color' }],
			html: (p, s) => `<tr><td align="${p.align}" style="padding:18px 32px 24px;font-family:${FONTS[s.font]};font-size:12px;line-height:1.6;color:${esc(p.color)};text-align:${p.align};border-top:1px solid #eceff3">${lines(p.text)}</td></tr>`,
		},
		html: {
			label: 'Custom HTML', icon: 'code', group: 'Layout',
			make: () => ({ code: '<p style="margin:0;padding:8px 32px;font-family:Arial,sans-serif;font-size:14px">Your HTML here</p>' }),
			schema: [{ key: 'code', label: 'HTML', type: 'code', hint: 'Use inline styles; email clients ignore most stylesheets.' }],
			html: (p) => `<tr><td>${p.code || ''}</td></tr>`,
		},
	})

	/** Make untrusted HTML safe to show inside this page (the editor canvas): no scripts, frames, forms, handlers or javascript: links. */
	CM.sanitizeHtml = (html) => {
		const doc = new DOMParser().parseFromString('<body>' + String(html || '') + '</body>', 'text/html')
		doc.querySelectorAll('script,iframe,frame,object,embed,link,meta,base,form,style,noscript,template').forEach((n) => n.remove())
		doc.body.querySelectorAll('*').forEach((el) => {
			;[...el.attributes].forEach((a) => {
				const name = a.name.toLowerCase(); const val = a.value.trim().toLowerCase().replace(/[\s\u0000-\u001f]/g, '')
				if (name.startsWith('on') || ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action' || name === 'formaction') && /^(javascript|data:text\/html|vbscript)/.test(val))) el.removeAttribute(a.name)
			})
		})
		return doc.body.innerHTML
	}

	CM.defaultBuilder = () => ({
		settings: { bg: '#f4f5f7', contentBg: '#ffffff', width: 600, font: 'Arial' },
		blocks: [
			{ id: CM.uid(), type: 'banner', props: T.banner.make() },
			{ id: CM.uid(), type: 'heading', props: T.heading.make() },
			{ id: CM.uid(), type: 'text', props: T.text.make() },
			{ id: CM.uid(), type: 'button', props: T.button.make() },
			{ id: CM.uid(), type: 'footer', props: T.footer.make() },
		],
	})
	CM.newBlock = (type) => ({ id: CM.uid(), type, props: T[type].make() })
	CM.FONTS = Object.keys(FONTS)

	/** Final email HTML for a builder document. */
	CM.renderBuilder = (doc) => {
		const s = doc.settings
		const rows = doc.blocks.map((b) => (T[b.type] ? T[b.type].html(b.props, s) : '')).join('')
		return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0;padding:0;background-color:${esc(s.bg)}"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="${+s.width || 600}" cellpadding="0" cellspacing="0" style="width:100%;max-width:${+s.width || 600}px;background-color:${esc(s.contentBg)};border-radius:10px;overflow:hidden">${rows}</table></td></tr></table>`
	}
	/** One block as the canvas shows it (a one-row table). */
	CM.renderBlockRow = (b, settings, chips) => {
		const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${T[b.type] ? T[b.type].html(b.props, settings) : ''}</table>`
		// in the canvas, show {{ variables }} in text as small chips (never inside attributes)
		return chips ? CM.sanitizeHtml(html).replace(/>([^<>]*\{\{[^<>]*)</g, (_m, t) => '>' + t.replace(/\{\{\s*(\w+)\s*\}\}/g, '<span style="display:inline-block;padding:0 7px;border-radius:99px;background:#efe9fd;color:#6d28d9;font:600 0.72em Arial,sans-serif;line-height:1.9;vertical-align:middle;white-space:nowrap">$1</span>') + '<')
			: html
	}

	/** Rich-text editor content -> a complete email body with inline styles. */
	CM.richToEmail = (content) => {
		const box = document.createElement('div')
		box.innerHTML = content
		const st = (sel, css) => box.querySelectorAll(sel).forEach((el) => { el.setAttribute('style', css + (el.getAttribute('style') ? ';' + el.getAttribute('style') : '')) })
		st('h1', 'margin:0 0 14px;font-size:26px;line-height:1.3;color:#14161a')
		st('h2', 'margin:18px 0 10px;font-size:20px;line-height:1.3;color:#14161a')
		st('h3', 'margin:16px 0 8px;font-size:17px;line-height:1.3;color:#14161a')
		st('p, div', 'margin:0 0 14px')
		st('ul, ol', 'margin:0 0 14px;padding-left:22px')
		st('li', 'margin:0 0 6px')
		st('a', 'color:#2563eb')
		st('img', 'max-width:100%;height:auto;border-radius:6px')
		st('blockquote', 'margin:0 0 14px;padding-left:14px;border-left:3px solid #d3d7de;color:#4b5563')
		box.querySelectorAll('img').forEach((im) => { const s = im.getAttribute('src') || ''; if (s.startsWith('/')) im.setAttribute('src', location.origin + s) })
		return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0;padding:0;background-color:#f4f5f7"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:10px"><tr><td style="padding:32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#3b4252">${box.innerHTML}</td></tr></table></td></tr></table>`
	}
	/** Content of a rich-text template (the part inside the wrapper), for editing again. */
	CM.richFromEmail = (html) => {
		const m = String(html || '').match(/line-height:1\.65;color:#3b4252">([\s\S]*)<\/td><\/tr><\/table><\/td><\/tr><\/table>\s*$/)
		return m ? m[1] : html || ''
	}

	/** Insert text at the caret of an input / textarea and tell Vue about it. */
	CM.insertAtCursor = (el, text) => {
		if (!el) return
		const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length
		el.value = el.value.slice(0, s) + text + el.value.slice(e)
		el.selectionStart = el.selectionEnd = s + text.length
		el.dispatchEvent(new Event('input', { bubbles: true })); el.focus()
	}

	/** Split HTML into tags, comments and text in ONE pass. (The regexes this replaces re-scanned to the end of the text from every
	 * unclosed "<", so a stray "<" in a big email made the work grow with the square of its size: 300 KB froze the tab for 9 seconds.)
	 * An unclosed tag or comment, and anything after it, is kept as plain text. */
	function tokenize(html, strict) {
		const s = String(html); const n = s.length; const out = []
		let i = 0
		while (i < n) {
			const lt = s.indexOf('<', i)
			if (lt < 0) { out.push(s.slice(i)); break }
			if (lt > i) out.push(s.slice(i, lt))
			// strict: a "<" starts a tag only before a letter, "/" and a letter, or "!--" (so "a < b" is just text)
			if (strict && !/^<(\/?[a-zA-Z]|!--)/.test(s.substr(lt, 4))) { out.push('<'); i = lt + 1; continue }
			if (s.startsWith('<!--', lt)) {
				const end = s.indexOf('-->', lt + 4)
				if (end >= 0) { out.push(s.slice(lt, end + 3)); i = end + 3; continue }
			}
			const gt = s.indexOf('>', lt + 1)
			if (gt < 0) { out.push(s.slice(lt)); break } // no ">" anywhere after this point, so no later "<" can close either
			if (gt === lt + 1) { out.push('<'); i = lt + 1; continue } // "<>" opens nothing
			out.push(s.slice(lt, gt + 1)); i = gt + 1
		}
		return out
	}
	const isTag = (t) => t[0] === '<' && t.endsWith('>') && !t.startsWith('<!--')

	/** Pretty-print HTML: block tags on their own lines, inline content kept together. */
	CM.formatHtml = (html) => {
		const BLOCK = /^(table|thead|tbody|tfoot|tr|td|th|div|p|h[1-6]|ul|ol|li|section|header|footer|blockquote|center|body|html|head|style)$/i
		const VOID = /^(br|hr|img|meta|link|input)$/i
		const tokens = tokenize(String(html).replace(/>\s+</g, '><'))
		let depth = 0; let out = ''; let lineOpen = false
		const nl = () => { out += '\n' + '  '.repeat(Math.max(0, depth)); lineOpen = false }
		tokens.forEach((t) => {
			if (!isTag(t)) { out += t.trim() ? t.replace(/\s+/g, ' ') : ''; lineOpen = true; return }
			const closing = t[1] === '/'; const name = (t.match(/^<\/?([a-zA-Z0-9]+)/) || [])[1] || ''
			const block = BLOCK.test(name); const selfClosed = VOID.test(name) || /\/>$/.test(t)
			if (closing) { if (block) { depth--; nl() } out += t; return }
			if (block) { if (out) nl(); out += t; if (!selfClosed) depth++; if (!/^<(td|th|p|li|h[1-6])\b/i.test(t) || true) nl(); return }
			out += t
		})
		return out.replace(/\n\s*\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
	}
	/** Simple well-formedness check; returns a list of problems. */
	CM.validateHtml = (html) => {
		const VOID = /^(br|hr|img|meta|link|input|area|base|col|embed|source|wbr)$/i
		const stack = []; const problems = []
		const tokens = tokenize(html, true)
		const clean = tokens.filter((t) => !t.startsWith('<!--')).join('')
		tokens.forEach((t) => {
			if (!isTag(t)) return
			const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b/.exec(t)
			if (!m) return
			const [, close, name] = m
			if (VOID.test(name) || t.endsWith('/>')) return
			if (!close) stack.push(name.toLowerCase())
			else {
				const top = stack.pop()
				if (top !== name.toLowerCase()) { problems.push(top ? `Found </${name}> but <${top}> is still open.` : `Found </${name}> with no matching opening tag.`); if (top && stack.includes(name.toLowerCase())) { while (stack.length && stack.pop() !== name.toLowerCase()); } }
			}
		})
		stack.reverse().forEach((n) => problems.push(`<${n}> is never closed.`))
		if (/<script/i.test(clean)) problems.push('Scripts are removed by email clients. Remove the <script> tag.')
		if (!/<(table|div|p|h1|a|img)/i.test(clean) && clean.trim()) problems.push('No HTML elements found. Wrap your text in a <p> or <table>.')
		return problems.slice(0, 6)
	}
	/** Wrap every closed HTML comment of the escaped source (one pass; an unclosed one stays plain). */
	function wrapComments(s) {
		let out = ''; let i = 0
		for (;;) {
			const a = s.indexOf('&lt;!--', i); if (a < 0) break
			const b = s.indexOf('--&gt;', a + 7); if (b < 0) break
			out += s.slice(i, a) + '<span class="hl-c">' + s.slice(a, b + 6) + '</span>'
			i = b + 6
		}
		return out + s.slice(i)
	}
	/** Syntax highlight overlay for the code editor. */
	CM.highlightHtml = (src) => {
		let s = wrapComments(CM.escape(src))
		s = s.replace(/(\{\{[^}]{0,120}\}\})/g, '<span class="hl-v">$1</span>')
		s = s.replace(/(&lt;\/?)([a-zA-Z0-9]+)((?:(?!&lt;)[\s\S])*?)(\/?&gt;)/g, (_m, a, tag, attrs, z) => `<span class="hl-p">${a}</span><span class="hl-t">${tag}</span>${attrs.replace(/([a-zA-Z-:]+)(=)(&quot;[\s\S]*?&quot;|&#39;[\s\S]*?&#39;)/g, '<span class="hl-a">$1</span>$2<span class="hl-s">$3</span>')}<span class="hl-p">${z}</span>`)
		return s + '\n'
	}
})()
