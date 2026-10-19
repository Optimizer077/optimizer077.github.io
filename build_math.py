#!/usr/bin/env python3
"""build_math.py - typeset the site's equations as MathML and fill in the BibTeX blocks (stdlib only).

    python build_math.py          # regenerate assets/js/processes.js and the marked blocks in index.html
    python build_math.py --check  # parse every equation and print sizes, change nothing

Equations are written below in a small LaTeX subset and converted to MathML, which current browsers
typeset natively (no KaTeX download, nothing to load). Outputs:

  * assets/js/processes.js   window.PROCESSES = [{id, cap, eq, eqHero}]  (portrait caption + formula)
  * index.html               the text between <!--math:KEY--> and <!--/math:KEY-->  (publication equations)
                             and between <!--cite:KEY--> and <!--/cite:KEY-->  (the BibTeX "Cite" panel)

Supported TeX: letters, digits, + - = < > , ; : ( ) [ ] | ! . ' ^ _  \\frac \\tfrac \\sqrt \\sum \\int \\prod
\\min \\max \\sin \\cos \\exp \\log \\operatorname \\text \\mathrm \\mathbf \\mathcal \\mathbb \\left \\right
\\lVert \\rVert \\lvert \\rvert \\dot \\ddot \\bar \\hat \\tilde \\vec, Greek letters, common symbols and spaces.
"""
import html
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.abspath(__file__))

# ----------------------------------------------------------------------------------------------
# 1. TeX subset -> MathML
# ----------------------------------------------------------------------------------------------
GREEK = {
    'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'delta': 'δ', 'epsilon': 'ϵ', 'varepsilon': 'ε', 'zeta': 'ζ',
    'eta': 'η', 'theta': 'θ', 'vartheta': 'ϑ', 'iota': 'ι', 'kappa': 'κ', 'lambda': 'λ', 'mu': 'μ', 'nu': 'ν',
    'xi': 'ξ', 'pi': 'π', 'rho': 'ρ', 'sigma': 'σ', 'tau': 'τ', 'upsilon': 'υ', 'phi': 'φ', 'varphi': 'ϕ',
    'chi': 'χ', 'psi': 'ψ', 'omega': 'ω',
}
GREEK_CAP = {'Gamma': 'Γ', 'Delta': 'Δ', 'Theta': 'Θ', 'Lambda': 'Λ', 'Xi': 'Ξ', 'Pi': 'Π', 'Sigma': 'Σ',
             'Phi': 'Φ', 'Psi': 'Ψ', 'Omega': 'Ω'}
SYMBOLS = {  # command -> operator character
    'cdot': '⋅', 'times': '×', 'approx': '≈', 'sim': '∼', 'propto': '∝', 'to': '→', 'rightarrow': '→',
    'longrightarrow': '⟶', 'pm': '±', 'leq': '≤', 'le': '≤', 'geq': '≥', 'ge': '≥', 'neq': '≠', 'in': '∈',
    'subset': '⊂', 'subseteq': '⊆', 'ldots': '…', 'circ': '∘', 'odot': '⊙',
}
IDENT_SYMBOLS = {'partial': '∂', 'nabla': '∇', 'infty': '∞', 'ell': 'ℓ'}  # upright identifiers
BIG_OPS = {'sum': '∑', 'int': '∫', 'prod': '∏'}
FUNCS = {'sin', 'cos', 'tan', 'exp', 'log', 'ln', 'min', 'max', 'det', 'lim'}
UNDER_FUNCS = {'min', 'max', 'lim'}                  # limits sit underneath
ACCENTS = {'dot': '˙', 'ddot': '¨', 'bar': '¯', 'hat': 'ˆ', 'tilde': '˜', 'vec': '→'}
SPACES = {',': '0.1667em', ';': '0.2778em', '!': '-0.1667em', 'quad': '1em', 'qquad': '2em', ' ': '0.2778em'}
# delimiters accepted after \left / \right, and the \lVert ... \rVert style pairs
DELIM_CMDS = {'lVert': '‖', 'rVert': '‖', 'lvert': '|', 'rvert': '|', '{': '{', '}': '}', '|': '‖',
              'langle': '⟨', 'rangle': '⟩', 'lfloor': '⌊', 'rfloor': '⌋', 'lceil': '⌈', 'rceil': '⌉'}
PAIRS = {'lVert': 'rVert', 'lvert': 'rvert'}

_SCRIPT_CAP = {'B': 'ℬ', 'E': 'ℰ', 'F': 'ℱ', 'H': 'ℋ', 'I': 'ℐ', 'L': 'ℒ', 'M': 'ℳ', 'R': 'ℛ'}
_DOUBLE = {'C': 'ℂ', 'H': 'ℍ', 'N': 'ℕ', 'P': 'ℙ', 'Q': 'ℚ', 'R': 'ℝ', 'Z': 'ℤ'}

# attribute sets that keep plain delimiters at text size and tight, the way TeX sets them
OPEN_ATTR = 'form="prefix" stretchy="false" lspace="0" rspace="0"'
CLOSE_ATTR = 'form="postfix" stretchy="false" lspace="0" rspace="0"'


def _styled(ch, kind):
    """Map one character to its Unicode mathematical alphanumeric variant."""
    if kind == 'bf':
        if 'A' <= ch <= 'Z': return chr(0x1D400 + ord(ch) - 65)
        if 'a' <= ch <= 'z': return chr(0x1D41A + ord(ch) - 97)
        if '0' <= ch <= '9': return chr(0x1D7CE + ord(ch) - 48)
    if kind == 'cal' and 'A' <= ch <= 'Z':
        return _SCRIPT_CAP.get(ch) or chr(0x1D49C + ord(ch) - 65)
    if kind == 'bb' and 'A' <= ch <= 'Z':
        return _DOUBLE.get(ch) or chr(0x1D538 + ord(ch) - 65)
    return ch


def esc(s):
    return html.escape(s, quote=False)


class Atom:
    """One parsed item: its MathML, markup to append after any scripts (the invisible function
    application), whether limits sit underneath, and its TeX class (ord, op, open, bigop, func, inner;
    None for spaces), which decides unary versus binary minus and the thin spaces between atoms."""
    __slots__ = ('xml', 'after', 'under', 'kind')

    def __init__(self, xml, kind='ord', after='', under=False):
        self.xml, self.kind, self.after, self.under = xml, kind, after, under


APPLY = '<mo>&#x2061;</mo>'
THIN_SPACE = '<mspace width="0.1667em"></mspace>'
# TeX puts a thin space between these pairs of adjacent atoms (operator names, big operators, fractions)
THIN = ({(a, b) for a in ('ord', 'grp', 'bigop', 'inner', 'func') for b in ('func', 'inner', 'bigop')}
        | {('bigop', 'ord'), ('func', 'ord'), ('inner', 'ord')})
UNARY_OK = ('start', 'op', 'open', 'bigop', 'func')    # a minus right after one of these is unary


class Tex:
    def __init__(self, src):
        self.s = src
        self.i = 0
        self.last = 'start'          # class of the previous atom in the current sequence

    # -- cursor helpers --------------------------------------------------------------------
    def skip_ws(self):
        while self.i < len(self.s) and self.s[self.i] in ' \t\n':
            self.i += 1

    def peek(self):
        self.skip_ws()
        return self.s[self.i] if self.i < len(self.s) else ''

    def peek_cmd(self):
        self.skip_ws()
        m = re.match(r'\\([A-Za-z]+|.)', self.s[self.i:])
        return m.group(1) if m else ''

    def read_cmd(self):
        self.skip_ws()
        m = re.match(r'\\([A-Za-z]+|.)', self.s[self.i:])
        self.i += m.end()
        return m.group(1)

    # -- grammar ---------------------------------------------------------------------------
    def parse(self):
        out = self.seq(set())
        if self.i < len(self.s):
            raise ValueError(f'unparsed tail: {self.s[self.i:self.i + 20]!r}')
        return self.wrap(out)

    @staticmethod
    def wrap(items):
        return items[0] if len(items) == 1 else '<mrow>' + ''.join(items) + '</mrow>'

    def seq(self, stop):
        """Parse items until the end, a '}' or one of the stop commands (left unconsumed)."""
        items = []
        self.last = 'start'
        gap = False                                      # an explicit space sits between the two atoms
        while True:
            c = self.peek()
            if c == '' or c == '}':
                break
            if c == '\\' and self.peek_cmd() in stop:
                break
            prev = self.last                             # atom() may recurse and overwrite self.last
            a = self.atom()
            if a.kind is None:                           # spaces and text are transparent
                gap = True
                items.append(self.script(a))
                self.last = prev
                continue
            if not gap and (prev, a.kind) in THIN:
                items.append(THIN_SPACE)
            items.append(self.script(a))
            self.last, gap = a.kind, False
        return items

    def arg(self):
        """One TeX argument: a {group}, or a single token (one digit, one letter, one command)."""
        if self.peek() == '{':
            self.i += 1
            items = self.seq(set())
            if self.peek() != '}':
                raise ValueError('missing }')
            self.i += 1
            return self.wrap(items) if items else '<mrow></mrow>'
        a = self.atom(single=True)
        return a.xml + a.after

    def script(self, a):
        sub = sup = None
        while True:
            c = self.peek()
            if c in ('^', '_'):
                self.i += 1
                if c == '^': sup = self.arg()
                else: sub = self.arg()
            elif c == "'":
                n = 0
                while self.peek() == "'":
                    self.i += 1
                    n += 1
                sup = '<mo>' + '′″‴'[min(n, 3) - 1] + '</mo>'
            else:
                break
        base = a.xml
        if sub is None and sup is None:
            return base + a.after
        if a.under:
            tag = 'munderover' if (sub is not None and sup is not None) else ('munder' if sub is not None else 'mover')
            parts = base + (sub or '') + (sup or '')
            return f'<{tag}>{parts}</{tag}>' + a.after
        if sub is not None and sup is not None:
            return f'<msubsup>{base}{sub}{sup}</msubsup>' + a.after
        if sub is not None:
            return f'<msub>{base}{sub}</msub>' + a.after
        return f'<msup>{base}{sup}</msup>' + a.after

    def atom(self, single=False):
        c = self.peek()
        if c == '{':
            return Atom(self.arg())
        if c == '\\':
            return self.command()
        self.i += 1
        if c.isalpha():
            return Atom(f'<mi>{c}</mi>')
        if c.isdigit() or (c == '.' and self.s[self.i:self.i + 1].isdigit()):
            if single:
                return Atom(f'<mn>{c}</mn>')
            j, seen_dot = self.i, c == '.'
            while j < len(self.s) and (self.s[j].isdigit() or (self.s[j] == '.' and not seen_dot and self.s[j + 1:j + 2].isdigit())):
                seen_dot = seen_dot or self.s[j] == '.'
                j += 1
            num = c + self.s[self.i:j]
            self.i = j
            return Atom(f'<mn>{num}</mn>')
        if c == '-':
            if self.last in UNARY_OK:                        # unary minus: no space after it
                return Atom('<mo form="prefix" lspace="0" rspace="0">−</mo>', 'op')
            return Atom('<mo>−</mo>', 'op')
        if c in '+=<>,;:/':
            sym = {'<': '&lt;', '>': '&gt;'}.get(c, c)
            return Atom(f'<mo>{sym}</mo>', 'op')
        if c == '!':
            return Atom('<mo form="postfix" lspace="0">!</mo>')
        if c in '([':
            return Atom(f'<mo {OPEN_ATTR}>{c}</mo>', 'open')
        if c in ')]':
            return Atom(f'<mo {CLOSE_ATTR}>{c}</mo>')
        if c == '|':
            return Atom('<mo stretchy="false" lspace="0" rspace="0">|</mo>')
        raise ValueError(f'unsupported character {c!r} at {self.i - 1} in {self.s!r}')

    def read_delim(self):
        self.skip_ws()
        if self.s[self.i] == '\\':
            name = self.read_cmd()
            if name not in DELIM_CMDS:
                raise ValueError(f'unsupported delimiter \\{name}')
            return DELIM_CMDS[name]
        ch = self.s[self.i]
        self.i += 1
        return '' if ch == '.' else ch

    @staticmethod
    def fence(ch, form):
        if not ch:
            return ''
        return f'<mo form="{form}" stretchy="true" symmetric="true" lspace="0" rspace="0">{ch}</mo>'

    def command(self):
        name = self.read_cmd()
        if name in GREEK:
            return Atom(f'<mi>{GREEK[name]}</mi>')
        if name in GREEK_CAP:
            return Atom(f'<mi mathvariant="normal">{GREEK_CAP[name]}</mi>')
        if name in SYMBOLS:
            return Atom(f'<mo>{SYMBOLS[name]}</mo>', 'op')
        if name in IDENT_SYMBOLS:
            return Atom(f'<mi mathvariant="normal">{IDENT_SYMBOLS[name]}</mi>')
        if name in BIG_OPS:
            return Atom(f'<mo>{BIG_OPS[name]}</mo>', 'bigop')
        if name in FUNCS:
            return Atom(f'<mi>{name}</mi>', 'func', after=APPLY, under=name in UNDER_FUNCS)
        if name in SPACES:
            return Atom(f'<mspace width="{SPACES[name]}"></mspace>', None)
        if name in ('{', '}'):
            return Atom(f'<mo {OPEN_ATTR if name == "{" else CLOSE_ATTR}>{name}</mo>', 'open' if name == '{' else 'ord')
        if name == '#':
            return Atom('<mo>#</mo>')
        if name in ('frac', 'tfrac', 'dfrac'):
            a = self.arg()
            b = self.arg()
            return Atom(f'<mfrac>{a}{b}</mfrac>', 'inner')
        if name == 'binom':
            a = self.arg()
            b = self.arg()
            return Atom(f'<mrow>{self.fence("(", "prefix")}<mfrac linethickness="0">{a}{b}</mfrac>{self.fence(")", "postfix")}</mrow>', 'inner')
        if name == 'sqrt':
            return Atom(f'<msqrt>{self.arg()}</msqrt>')
        if name in ACCENTS:
            base = self.arg()
            return Atom(f'<mover accent="true">{base}<mo>{ACCENTS[name]}</mo></mover>')
        if name in ('mathbf', 'mathcal', 'mathbb'):
            kind = {'mathbf': 'bf', 'mathcal': 'cal', 'mathbb': 'bb'}[name]
            a = self.arg()
            return Atom(re.sub(r'<(mi|mn)>([^<]+)</\1>',
                               lambda m: f'<{m.group(1)}>' + ''.join(_styled(ch, kind) for ch in m.group(2)) + f'</{m.group(1)}>', a))
        if name == 'mathrm':
            text = re.sub(r'<[^>]+>', '', self.arg())
            return Atom(f'<mi mathvariant="normal">{text}</mi>' if len(text) == 1 else f'<mi>{text}</mi>')
        if name == 'operatorname':
            text = re.sub(r'<[^>]+>', '', self.arg())
            return Atom(f'<mi>{text}</mi>', 'func', after=APPLY)
        if name == 'text':
            self.skip_ws()
            if self.s[self.i] != '{':
                raise ValueError('\\text needs braces')
            j = self.s.index('}', self.i)
            text = self.s[self.i + 1:j]
            self.i = j + 1
            return Atom(f'<mtext>{esc(text).replace(" ", "&#160;")}</mtext>', None)
        if name == 'left':
            open_ch = self.read_delim()
            inner = ''.join(self.seq({'right'}))
            if self.read_cmd() != 'right':
                raise ValueError('missing \\right')
            close_ch = self.read_delim()
            if open_ch in ('(', '[', '{') and not re.search(r'<(mfrac|msqrt|munder)', inner):
                # nothing tall inside: plain text-size delimiters, as TeX would size them
                o = f'<mo {OPEN_ATTR}>{open_ch}</mo>'
                c = f'<mo {CLOSE_ATTR}>{close_ch}</mo>' if close_ch else ''
                return Atom('<mrow>' + o + inner + c + '</mrow>', 'grp')
            return Atom('<mrow>' + self.fence(open_ch, 'prefix') + inner + self.fence(close_ch, 'postfix') + '</mrow>', 'grp')
        if name in PAIRS:                                   # \lVert ... \rVert, \lvert ... \rvert
            closer = PAIRS[name]
            inner = self.seq({closer})
            if self.read_cmd() != closer:
                raise ValueError(f'missing \\{closer}')
            return Atom('<mrow>' + self.fence(DELIM_CMDS[name], 'prefix') + ''.join(inner) + self.fence(DELIM_CMDS[closer], 'postfix') + '</mrow>', 'grp')
        raise ValueError(f'unsupported command \\{name}')


def mathml(tex, label=None):
    body = Tex(tex).parse()
    aria = f' aria-label="{html.escape(label, quote=True)}"' if label else ''
    return f'<math display="inline"{aria}>{body}</math>'


# ----------------------------------------------------------------------------------------------
# 2. Equation sources
# ----------------------------------------------------------------------------------------------
# (id, portrait caption, [formula, ...], optional portrait-only formulas). The id is the process name used by
# bg-scenes.js and hero-effects.js. Formulas are checked against what the shader / effect actually does.
PROCESSES = [
    ('diffusion', 'Diffusion: noised, then denoised back',
     [r'\mathbf{x}_t=\sqrt{\bar\alpha_t}\,\mathbf{x}_0+\sqrt{1-\bar\alpha_t}\,\varepsilon'], None),
    ('flow', 'Carried along a swirling flow, then back',
     [r'\dot{\mathbf{x}}=\left(\partial_y\psi,\;-\partial_x\psi\right)'], None),
    ('heat', 'The heat equation run on the photo, then played in reverse',
     [r'\partial_t u=\alpha\,\nabla^{2}u'], None),
    ('lorenz', 'Pulled onto the Lorenz attractor and back',
     [r'\dot x=\sigma(y-x)', r'\dot y=x(\rho-z)-y', r'\dot z=xy-\beta z'], None),
    ('flowmatch', 'Flow matching: straight paths to noise and back',
     [r'\mathbf{x}_t=(1-t)\,\varepsilon+t\,\mathbf{x}_1', r'v_t=\mathbf{x}_1-\varepsilon'], None),
    ('langevin', 'Rolling downhill into a loss landscape, then back',
     [r'd\mathbf{x}=-\nabla U(\mathbf{x})\,dt+\sqrt{2T}\,d\mathbf{W}_t'], None),
    ('wave', 'Ripples from the wave equation',
     [r'\partial_t^{2}u=c^{2}\nabla^{2}u'], None),
    ('vortex', 'Twisted by a vortex, then unwound',
     [r'\mathbf{u}(\mathbf{x})=\sum_i\frac{\Gamma_i}{2\pi}\,\frac{\hat{z}\times(\mathbf{x}-\mathbf{x}_i)}{\lvert\mathbf{x}-\mathbf{x}_i\rvert^{2}}'], None),
    ('gravity', 'Bent by a point mass into an Einstein ring',
     [r'\ddot{\mathbf{r}}=-\frac{GM}{\lvert\mathbf{r}\rvert^{3}}\,\mathbf{r}'],
     [r'\theta_\pm=\tfrac12\left(\beta\pm\sqrt{\beta^{2}+4\theta_E^{2}}\right)']),
    ('kmeans', 'Colours sorted into six clusters (k-means)',
     [r'\min_{\mu}\sum_i\min_j\lVert x_i-\mu_j\rVert^{2}'], None),
    ('rossler', 'Wound onto the Rössler attractor, then back',
     [r'\dot x=-y-z', r'\dot y=x+ay', r'\dot z=b+z(x-c)'], None),
    ('clifford', 'Folded by the Clifford map, then back',
     [r'x_{n+1}=\sin(ay_n)+c\cos(ax_n)', r'y_{n+1}=\sin(bx_n)+d\cos(by_n)'], None),
    ('doublependulum', 'Swung by a double pendulum: the butterfly effect',
     [r'L=T-V', r'\frac{d}{dt}\frac{\partial L}{\partial\dot\theta_i}-\frac{\partial L}{\partial\theta_i}=0,\quad i=1,2'], None),
    ('doublegyre', 'Stirred by a double-gyre flow, then back',
     [r'\psi=A\sin\left(\pi f(x,t)\right)\sin(\pi y)', r'\mathbf{u}=\left(-\partial_y\psi,\;\partial_x\psi\right)'], None),
    ('vanderpol', 'Spiralling onto a Van der Pol limit cycle',
     [r'\ddot x-\mu(1-x^{2})\dot x+x=0'], None),
    ('chaosgame', 'Chaos game: halfway jumps build a Sierpiński triangle',
     [r'\mathbf{x}_{n+1}=\tfrac12\left(\mathbf{x}_n+\mathbf{v}_{k_n}\right),\quad k_n\in\{1,2,3\}'], None),
    ('levy', 'Lévy flights: many short hops, a few huge ones',
     [r'P(\ell)\sim\ell^{-1-\alpha},\quad 0<\alpha<2'], None),
    ('mcmc', 'Metropolis walkers settle into a banana-shaped density',
     [r"a(x\to x')=\min\left(1,\frac{\pi(x')}{\pi(x)}\right)"], None),
    ('kuramoto', 'Kuramoto: oscillators fall into step',
     [r'\dot\theta_i=\omega_i+\frac{K}{N}\sum_{j=1}^{N}\sin(\theta_j-\theta_i)'], None),
    ('chladni', 'Chladni figure: sand gathers on the nodal lines',
     [r'\cos(n\pi x)\cos(m\pi y)-\cos(m\pi x)\cos(n\pi y)=0'], None),
    ('doubleslit', 'Double slit: pixels land in interference fringes',
     [r'I(x)\propto\cos^{2}\left(\frac{\pi d x}{\lambda L}\right)\operatorname{sinc}^{2}\left(\frac{\pi a x}{\lambda L}\right)'], None),
    ('cyclotron', 'Cyclotron motion with an E×B drift',
     [r'm\dot{\mathbf{v}}=q\left(\mathbf{E}+\mathbf{v}\times\mathbf{B}\right)', r'\mathbf{v}_d=\frac{\mathbf{E}\times\mathbf{B}}{B^{2}}'], None),
    ('phyllotaxis', 'Phyllotaxis: seeds placed at the golden angle',
     [r'r_n=c\sqrt{n}', r'\theta_n\approx n\cdot137.5^{\circ}'], None),
    ('lissajous', 'A Lissajous curve traced by the pixels',
     [r'x=A\sin(at+\delta)', r'y=B\sin(bt)'], None),
    ('montecarlo', 'Monte Carlo darts estimate π',
     [r'\pi\approx4\,\frac{N_{\mathrm{in}}}{N}'], None),
    ('galaxy', 'Differential rotation winds up a spiral galaxy',
     [r'\theta(r,t)=\theta_0+\Omega(r)\,t', r'\Omega\propto\frac{1}{r}'], None),
    ('transport', 'Optimal transport: pixels re-sorted by brightness',
     [r'\min_{T}\int\lVert x-T(x)\rVert^{2}\,d\mu(x)', r'T_{\#}\mu=\nu'], None),
    ('bridge', 'Brownian bridge: random paths pinned at both ends',
     [r'B(s)=\sum_{k\ge1}\xi_k\,\frac{\sqrt{2}\,\sin(k\pi s)}{k\pi}'], None),
    ('fountain', 'A ballistic fountain: parabolas under gravity',
     [r'\mathbf{r}(t)=\mathbf{r}_0+\mathbf{v}_0t+\tfrac12\mathbf{g}t^{2}'], None),
    ('cosmicweb', "Zel'dovich approximation: the cosmic web forms",
     [r'\mathbf{x}(t)=\mathbf{q}-D(t)\,\nabla\Phi_0(\mathbf{q})'], None),
]

# Publication equations: (label, [TeX parts], spoken form for screen readers). Parts are separate <math> elements
# so a long equation can wrap onto a second line on a phone instead of overflowing.
PUBLICATIONS = {
    # I-INR: training objective and inference step, quoted from arXiv:2504.17364 (Sec. 4 and Algorithm 2).
    'iinr': [
        ('Training',
         [r'\min_\theta\;\mathbb{E}\,\left\lVert f_\theta\left(\tilde g(x)_t,\,x,\,t\right)-\mathcal{I}(x)\right\rVert_2^{2}',
          r'\tilde g(x)_t=(1-t)\,\mathcal{I}(x)+t\,\mathcal{Z}+\varepsilon\,t\,n'],
         'Training objective: minimize the expected squared error between the network output f theta, given a noisy blend of the signal I of x and a latent Z, and the clean signal I of x.'),
        ('Refinement step',
         [r'\hat g(x)_{t-\delta}=\frac{\delta}{t}\,f_\theta\left(\hat g(x)_t,\,x,\,t\right)+\left(1-\frac{\delta}{t}\right)\hat g(x)_t'],
         'Refinement step: the estimate at time t minus delta is delta over t times the network prediction, plus one minus delta over t times the current estimate.'),
    ],
    # DescanDiffusion: colour renormalisation and conditional DDPM loss, quoted from arXiv:2402.05350.
    'descan': [
        ('Colour correction',
         [r'I_c^{k}=\frac{I_s^{k}-\mu_s^{k}}{\sigma_s^{k}+\varepsilon}\,\sigma_c^{k}+\mu_c^{k}'],
         'Colour correction: each channel k of the scanned image is standardized by its own mean and standard deviation, then rescaled to the target mean and standard deviation.'),
        ('Diffusion loss',
         [r'L=\mathbb{E}\left\lVert\epsilon-\epsilon_\theta\left(x_t,\,t,\,I_c,\,v_c\right)\right\rVert'],
         'Diffusion loss: the expected norm of the difference between the true noise epsilon and the noise predicted from x t, t, the corrected image I c and the colour vector v c.'),
    ],
    # FCRN: a sketch, read off the block diagram of Fig. 1 (density map -> threshold -> contours -> centroids).
    'fcrn': [
        ('Detection pipeline (a sketch, not an equation from the paper)',
         [r'\hat D=F_\theta(I)',
          r'\mathbf{c}_k=\frac{1}{\lvert R_k\rvert}\sum_{p\in R_k}p,\quad R_k\subset\{\hat D>\tau\}'],
         'Detection pipeline, a sketch rather than an equation from the paper: the network F theta maps the image I to a density map D hat; each connected region R k where the density exceeds a threshold tau yields one position, its centroid c k.'),
    ],
    # KMBE 2024: a sketch, from the abstract (robust loss in place of the mean-square objective) and Fig. 1 (c = 0.8).
    'kmbe': [
        ('Objective (a sketch, not an equation from the paper)',
         [r'\frac1N\sum_i\lVert f_\theta(x_i)-y_i\rVert_2^{2}\;\longrightarrow\;\frac1N\sum_i\rho_c\left(f_\theta(x_i)-y_i\right)',
          r'c=0.8'],
         'Objective, a sketch rather than an equation from the paper: the mean squared error is replaced by the mean of a robust loss rho c of the residual, with c equal to 0.8.'),
    ],
}

# BibTeX, shown in each citation's "Cite" panel. Metadata checked against Crossref (AAAI, Elsevier) and the site's own entries.
BIBTEX = {
    'iinr': r'''@inproceedings{haider2026iinr,
  title     = {{I-INR}: Iterative Implicit Neural Representations},
  author    = {Haider, Ali and Ali, Muhammad Salman and Qamar, Maryam and Khalil, Tahir and Kim, Soo Ye and Oh, Jihyong and Tartaglione, Enzo and Bae, Sung-Ho},
  booktitle = {Proceedings of the AAAI Conference on Artificial Intelligence},
  volume    = {40},
  number    = {6},
  pages     = {4520--4528},
  year      = {2026},
  doi       = {10.1609/aaai.v40i6.42451},
  eprint    = {2504.17364},
  archivePrefix = {arXiv}
}''',
    'descan': r'''@inproceedings{cha2024descanning,
  title     = {Descanning: From Scanned to the Original Images with a Color Correction Diffusion Model},
  author    = {Cha, Junghun and Haider, Ali and Yang, Seoyun and Jin, Hoeyeong and Yang, Subin and Uddin, A. F. M. Shahab and Kim, Jaehyoung and Kim, Soo Ye and Bae, Sung-Ho},
  booktitle = {Proceedings of the AAAI Conference on Artificial Intelligence},
  volume    = {38},
  number    = {2},
  pages     = {954--963},
  year      = {2024},
  doi       = {10.1609/aaai.v38i2.27855}
}''',
    'fcrn': r'''@article{haider2021fcrn,
  title   = {Human Detection in Aerial Thermal Imaging using a Fully Convolutional Regression Network},
  author  = {Haider, Ali and Shaukat, Furqan and Mir, Junaid},
  journal = {Infrared Physics \& Technology},
  volume  = {116},
  pages   = {103796},
  year    = {2021},
  doi     = {10.1016/j.infrared.2021.103796}
}''',
    'kmbe': r'''@inproceedings{haider2024kmbe,
  title     = {Improving Implicit Neural Representations with Robust Loss Function},
  author    = {Haider, Ali and Bae, Sung Ho},
  booktitle = {Korea Broadcasting Media Engineering Conference},
  pages     = {998--1001},
  year      = {2024}
}''',
    'patent': r'''@misc{bae2024patent,
  title        = {Apparatus and Method for Image Restoration Based on Machine Learning},
  author       = {Bae, Sung-Ho and Cha, Junghun and Haider, Ali},
  year         = {2024},
  howpublished = {Korean Intellectual Property Office (KIPO), No.~10-2024-0169006},
  doi          = {10.8080/1020240169006}
}''',
}


# ----------------------------------------------------------------------------------------------
# 3. Outputs
# ----------------------------------------------------------------------------------------------
def parts(formulas):
    return ''.join(f'<span class="eq-part">{mathml(t)}</span>' for t in formulas)


def build_processes_js():
    rows = [{'id': pid, 'cap': cap, 'eq': parts(eq), 'eqHero': parts(eq_hero) if eq_hero else ''}
            for pid, cap, eq, eq_hero in PROCESSES]
    head = ('/* Generated by build_math.py from LaTeX sources; edit that file, not this one.\n'
            '   Each process: portrait caption (cap) and its formula as MathML (eq; eqHero when the portrait\n'
            '   effect shows a different formula than the background). */\n')
    body = 'window.PROCESSES = [\n' + ',\n'.join('  ' + json.dumps(r, ensure_ascii=False) for r in rows) + '\n];\n'
    return head + body


def pub_block(key):
    out = []
    for label, tex_parts, spoken in PUBLICATIONS[key]:
        row = ''.join(f'<span class="eq-part" tabindex="-1">{mathml(t)}</span>' for t in tex_parts)
        out.append(f'<p class="pub-eq"><span class="eq-label">{esc(label)}</span>'
                   f'<span class="eq-row" role="img" aria-label="{html.escape(spoken, quote=True)}">{row}</span></p>')
    return '\n'.join(out)


def cite_block(key):
    return ('<details class="pub-cite">\n'
            '<summary>Cite</summary>\n'
            '<div class="cite-body">\n'
            f'<pre class="bibtex" tabindex="0"><code>{esc(BIBTEX[key])}</code></pre>\n'
            '<button class="cite-copy" type="button">Copy BibTeX</button>\n'
            '</div>\n'
            '</details>')


def fill(src, tag, key, content, nl):
    pat = re.compile(r'^([ \t]*)(<!--%s:%s-->)(.*?)(<!--/%s:%s-->)' % (tag, key, tag, key), re.S | re.M)
    if not pat.search(src):
        raise SystemExit(f'marker <!--{tag}:{key}--> not found in index.html')

    def block(m):
        ind = m.group(1)                                   # keep the markers' indentation, but never inside <pre>
        lines, in_pre = [], False
        for ln in content.split('\n'):
            lines.append(ln if in_pre or not ln else ind + ln)
            if '<pre' in ln: in_pre = True
            if '</pre>' in ln: in_pre = False
        return ind + m.group(2) + nl + nl.join(lines) + nl + ind + m.group(4)
    return pat.sub(block, src, count=1)


def update_html(path):
    with open(path, encoding='utf-8', newline='') as f:        # newline='' keeps CRLF files CRLF
        src = f.read()
    nl = '\r\n' if '\r\n' in src else '\n'
    n = 0
    for key in PUBLICATIONS:
        src = fill(src, 'math', key, pub_block(key), nl)
        n += 1
    for key in BIBTEX:
        src = fill(src, 'cite', key, cite_block(key), nl)
        n += 1
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(src)
    return n


def main():
    check = '--check' in sys.argv
    js = build_processes_js()
    total = sum(len(pub_block(k)) for k in PUBLICATIONS)
    print(f'{len(PROCESSES)} processes, {len(PUBLICATIONS)} equation blocks, {len(BIBTEX)} BibTeX entries; '
          f'processes.js {len(js) / 1024:.1f} KB; publication MathML {total / 1024:.1f} KB')
    if check:
        return
    with open(os.path.join(REPO, 'assets', 'js', 'processes.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(js)
    print('wrote assets/js/processes.js')
    print(update_html(os.path.join(REPO, 'index.html')), 'blocks updated in index.html')


if __name__ == '__main__':
    main()
