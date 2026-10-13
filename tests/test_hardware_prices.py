import unittest
from scripts.update_hardware_prices import parse_product, update

PRODUCT = dict(id='ssd', pcode='18297722', expected_title='삼성전자 990 PRO (2TB)')


def page(body, title=PRODUCT['expected_title']):
    return '<html><head><title>' + title + ' : 다나와 가격비교</title></head><body>' + body + '</body></html>'


class Prices(unittest.TestCase):
    def test_main_offer_not_discount_shipping_or_other_capacity(self):
        html = page('<script>최저가 1원 최저가 구매하기</script><span>최저가</span>'
                    '<a><em>671,890</em>원</a><a>최저가 구매하기</a>'
                    '<p>카드 혜택가 500,000원 배송비 4,000원</p>'
                    '<h3>쇼핑몰별 최저가</h3><p>현금 654,000원</p>'
                    '<p>다른 구성 1TB 최저가 100,000원 최저가 구매하기</p>')
        self.assertEqual(parse_product(html, PRODUCT), (671890, 'available'))

    def test_wrong_listing_block_and_invalid_price_fail_closed(self):
        for html in [page('최저가 200,000원 최저가 구매하기', title='삼성전자 990 PRO (1TB)'),
                     '<html>Access denied</html>', page('카드 200,000원'),
                     page('최저가 0원 최저가 구매하기'),
                     page('쇼핑몰별 최저가 200,000원 최저가 구매하기')]:
            with self.subTest(html=html), self.assertRaises(ValueError):
                parse_product(html, PRODUCT)

    def test_discontinued_is_not_zero_or_old_price(self):
        self.assertEqual(parse_product(page('단종 된 상품입니다.'), PRODUCT), (None, 'unavailable'))
        self.assertEqual(parse_product(page('가격비교 중지 상품입니다.'), PRODUCT), (None, 'unavailable'))
        prior = dict(products=[dict(id='ssd', pcode='18297722', price_krw=500000, checked_at='old', availability='available')])
        result = update(dict(products=[PRODUCT]), prior, lambda _: page('단종 된 상품입니다.'), 'now')
        self.assertIsNone(result['products'][0]['price_krw'])
        self.assertEqual(result['products'][0]['checked_at'], 'now')

    def test_failed_or_blocked_fetch_preserves_time_and_value(self):
        prior = dict(products=[dict(id='ssd', pcode='18297722', price_krw=500000, checked_at='old', availability='available')])
        def fail(_):
            raise OSError('network')
        result = update(dict(products=[PRODUCT]), prior, fail, 'now')['products'][0]
        self.assertEqual((result['price_krw'], result['checked_at'], result['attempted_at']), (500000, 'old', 'now'))
        self.assertTrue(result['fetch_error'])
        called = []
        update(dict(products=[PRODUCT]), prior, lambda url: called.append(url), 'now', allowed=lambda _: False)
        self.assertEqual(called, [])
        changed = dict(PRODUCT, pcode='999')
        result = update(dict(products=[changed]), prior, fail, 'now')['products'][0]
        self.assertIsNone(result['price_krw'])
        self.assertIsNone(result['checked_at'])


if __name__ == '__main__':
    unittest.main()
