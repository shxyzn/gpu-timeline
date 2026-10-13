"""Read a small, fixed Danawa watchlist. Never guess prices or bypass blocks."""
import argparse
import datetime as dt
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser

AGENT = 'CVML-GPU-Timeline/1.1.6 (+https://github.com/shxyzn/gpu-timeline)'
HOST = 'https://prod.danawa.com'
MAX_BYTES = 4 * 1024 * 1024


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        url = urllib.parse.urlparse(newurl)
        if url.scheme != 'https' or url.netloc != 'prod.danawa.com':
            raise ValueError('Unexpected redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_text(url):
    request = urllib.request.Request(url, headers={'User-Agent': AGENT, 'Accept-Language': 'ko-KR'})
    with urllib.request.build_opener(SafeRedirect).open(request, timeout=20) as response:
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError('Page too large')
        return data.decode(response.headers.get_content_charset() or 'utf-8')


class PageText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.title, self.stack = [], [], []

    def handle_starttag(self, tag, attrs):
        if tag not in {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in self.stack:
            self.stack = self.stack[:len(self.stack) - 1 - self.stack[::-1].index(tag)]

    def handle_data(self, value):
        if 'title' in self.stack:
            self.title.append(value)
        elif not any(tag in self.stack for tag in ('script', 'style', 'noscript', 'head')):
            self.parts.append(value)


def normalized(value):
    return re.sub(r'\s+', ' ', value).strip()


def parse_product(html, product):
    page = PageText()
    page.feed(html)
    # An exact listing title binds the number to the selected capacity/distributor.
    title = re.sub(r' : 다나와 가격비교$', '', normalized(' '.join(page.title)))
    if title != normalized(product['expected_title']):
        raise ValueError('Product title changed or access page returned')
    text = normalized(' '.join(page.parts))
    # Only the main offer, before seller tables/history/other variants. Ignore card,
    # membership, cash, installment and recommendation prices further down the page.
    text = re.split(r'쇼핑몰별 최저가|최저가 추이|상품 상세정보', text, maxsplit=1)[0]
    match = re.search(r'(?:^|\s)최저가\s+([0-9][0-9,]*)\s*원\s+최저가\s*구매하기', text)
    if match:
        amount = int(match.group(1).replace(',', ''))
        if not 1000 <= amount <= 200000000:
            raise ValueError('Invalid price')
        return amount, 'available'
    if re.search(r'단종\s*된 상품입니다|판매\s*중단\s*된 상품입니다|가격비교\s*중지\s*상품입니다|가격비교 예정|판매준비', text):
        return None, 'unavailable'
    raise ValueError('Main price could not be verified')


def update(catalog, previous, fetch, now, allowed=lambda url: True, pause=lambda: None):
    old = {row['id']: row for row in previous.get('products', [])}
    result = {'schema_version': 1, 'source': 'danawa', 'attempted_at': now, 'products': []}
    for product in catalog['products']:
        pcode = product['pcode']
        if not re.fullmatch(r'\d+', pcode):
            raise ValueError('Invalid product code')
        prior = old.get(product['id'], {})
        if prior.get('pcode') != pcode:
            prior = {}
        row = dict(id=product['id'], pcode=pcode, price_krw=prior.get('price_krw'),
                   availability=prior.get('availability', 'unknown'), checked_at=prior.get('checked_at'),
                   attempted_at=now, fetch_error=None)
        try:
            url = HOST + '/info/?pcode=' + pcode
            if not allowed(url):
                raise ValueError('Automated access unavailable')
            price, availability = parse_product(fetch(url), product)
            row.update(price_krw=price, availability=availability, checked_at=now)
        except (ValueError, OSError, UnicodeError) as error:
            # Preserve both value AND observation time. A failed attempt is not a
            # fresh price and must never become 0 won or a newly confirmed quote.
            row['fetch_error'] = type(error).__name__
        result['products'].append(row)
        pause()
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--catalog', default='dist/hardware-products.json')
    parser.add_argument('--previous', default='dist/hardware-prices.json')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    catalog = json.loads(Path(args.catalog).read_text())
    previous = json.loads(Path(args.previous).read_text()) if Path(args.previous).is_file() else {}
    robots = urllib.robotparser.RobotFileParser()
    try:
        robots.parse(fetch_text(HOST + '/robots.txt').splitlines())
        allowed = lambda url: robots.can_fetch(AGENT, url)
    except urllib.error.HTTPError as error:
        allow_missing = error.code == 404
        allowed = lambda url: allow_missing
    except (ValueError, OSError, UnicodeError):
        allowed = lambda url: False
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')
    result = update(catalog, previous, fetch_text, now, allowed, lambda: time.sleep(1))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(output)
    for row in result['products']:
        print('{}: {} {} ({})'.format(row['id'], row['price_krw'], row['availability'], row['fetch_error'] or 'verified'))
    failed = sum(bool(row['fetch_error']) for row in result['products'])
    if failed:
        print('::warning::{} products could not be refreshed; previous observation times preserved'.format(failed))


if __name__ == '__main__':
    main()
