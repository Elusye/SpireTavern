"""Compose cached Wiki card images; never fetch the network during a draw."""
import argparse,json,os,sys
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont

def render(cards,deck=False,start=1):
    if not isinstance(cards,list) or not 1<=len(cards)<=(25 if deck else 3) or not all(isinstance(c,str) for c in cards) or start<1:
        raise ValueError('Invalid card selection')
    manifest=json.loads(Path(__file__).with_name('card_image_manifest.json').read_text(encoding='utf-8'))
    directory=Path(os.environ.get('DSH_QQBOT_CARD_IMAGES_DIR','/root/qqbot-expanded-stage/wiki-cards'))
    font_path=os.environ.get('QQBOT_REPORT_FONT','C:/Windows/Fonts/msyh.ttc' if os.name=='nt' else '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
    columns=5 if deck else len(cards)
    width,height=(400,534) if deck else (480,640)
    image=Image.new('RGB',(width*columns,height*((len(cards)+columns-1)//columns)),'#111720')
    draw=ImageDraw.Draw(image)
    font=ImageFont.truetype(font_path,34)
    for index,identifier in enumerate(cards):
        x=(index%columns)*width;y=(index//columns)*height
        filename=manifest[identifier]
        if Path(filename).name!=filename:raise ValueError('Invalid image filename')
        with Image.open(directory/filename) as source:
            card=source.convert('RGBA');card.thumbnail((width-10,height-52),Image.Resampling.LANCZOS)
            image.paste(card,(x+(width-card.width)//2,y+4),card)
        draw.text((x+width//2,y+height-27),str(start+index),font=font,anchor='mm',fill='white')
    return image

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--cards',required=True);parser.add_argument('--output');parser.add_argument('--deck',action='store_true');parser.add_argument('--start',type=int,default=1)
    args=parser.parse_args();render(json.loads(args.cards),args.deck,args.start).save(args.output or sys.stdout.buffer,format='PNG')
