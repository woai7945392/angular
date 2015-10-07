import {
  isPresent,
  isBlank,
  StringWrapper,
  stringify,
  assertionsEnabled,
  StringJoiner,
  RegExpWrapper,
  serializeEnum,
  CONST_EXPR
} from 'angular2/src/facade/lang';
import {DOM} from 'angular2/src/core/dom/dom_adapter';
import {ListWrapper} from 'angular2/src/facade/collection';

import {HtmlAst, HtmlAttrAst, HtmlTextAst, HtmlElementAst} from './html_ast';

import {escapeDoubleQuoteString} from './util';
import {Injectable} from 'angular2/src/core/di';
import {HtmlToken, HtmlTokenType, tokenizeHtml} from './html_lexer';
import {ParseError, ParseLocation, ParseSourceSpan} from './parse_util';
import {HtmlTagDefinition, getHtmlTagDefinition} from './html_tags';

// TODO: remove this, just provide a plain error message!
export enum HtmlTreeErrorType {
  UnexpectedClosingTag
}

const HTML_ERROR_TYPE_MSGS = CONST_EXPR(['Unexpected closing tag']);


export class HtmlTreeError extends ParseError {
  static create(type: HtmlTreeErrorType, elementName: string,
                location: ParseLocation): HtmlTreeError {
    return new HtmlTreeError(type, HTML_ERROR_TYPE_MSGS[serializeEnum(type)], elementName,
                             location);
  }

  constructor(public type: HtmlTreeErrorType, msg: string, public elementName: string,
              location: ParseLocation) {
    super(location, msg);
  }
}

export class HtmlParseTreeResult {
  constructor(public rootNodes: HtmlAst[], public errors: ParseError[]) {}
}

@Injectable()
export class HtmlParser {
  parse(sourceContent: string, sourceUrl: string): HtmlParseTreeResult {
    var tokensAndErrors = tokenizeHtml(sourceContent, sourceUrl);
    var treeAndErrors = new TreeBuilder(tokensAndErrors.tokens).build();
    return new HtmlParseTreeResult(treeAndErrors.rootNodes, (<ParseError[]>tokensAndErrors.errors)
                                                                .concat(treeAndErrors.errors));
  }
}

var NS_PREFIX_RE = /^@[^:]+/g;

class TreeBuilder {
  private index: number = -1;
  private length: number;
  private peek: HtmlToken;

  private rootNodes: HtmlAst[] = [];
  private errors: HtmlTreeError[] = [];

  private elementStack: HtmlElementAst[] = [];

  constructor(private tokens: HtmlToken[]) { this._advance(); }

  build(): HtmlParseTreeResult {
    while (this.peek.type !== HtmlTokenType.EOF) {
      if (this.peek.type === HtmlTokenType.TAG_OPEN_START) {
        this._consumeStartTag(this._advance());
      } else if (this.peek.type === HtmlTokenType.TAG_CLOSE) {
        this._consumeEndTag(this._advance());
      } else if (this.peek.type === HtmlTokenType.CDATA_START) {
        this._consumeCdata(this._advance());
      } else if (this.peek.type === HtmlTokenType.COMMENT_START) {
        this._consumeComment(this._advance());
      } else if (this.peek.type === HtmlTokenType.TEXT ||
                 this.peek.type === HtmlTokenType.RAW_TEXT ||
                 this.peek.type === HtmlTokenType.ESCAPABLE_RAW_TEXT) {
        this._consumeText(this._advance());
      } else {
        // Skip all other tokens...
        this._advance();
      }
    }
    return new HtmlParseTreeResult(this.rootNodes, this.errors);
  }

  private _advance(): HtmlToken {
    var prev = this.peek;
    if (this.index < this.tokens.length - 1) {
      // Note: there is always an EOF token at the end
      this.index++;
    }
    this.peek = this.tokens[this.index];
    return prev;
  }

  private _advanceIf(type: HtmlTokenType): HtmlToken {
    if (this.peek.type === type) {
      return this._advance();
    }
    return null;
  }

  private _consumeCdata(startToken: HtmlToken) {
    this._consumeText(this._advance());
    this._advanceIf(HtmlTokenType.CDATA_END);
  }

  private _consumeComment(startToken: HtmlToken) {
    this._advanceIf(HtmlTokenType.RAW_TEXT);
    this._advanceIf(HtmlTokenType.COMMENT_END);
  }

  private _consumeText(token: HtmlToken) {
    this._addToParent(new HtmlTextAst(token.parts[0], token.sourceSpan));
  }

  private _consumeStartTag(startTagToken: HtmlToken) {
    var prefix = startTagToken.parts[0];
    var name = startTagToken.parts[1];
    var attrs = [];
    while (this.peek.type === HtmlTokenType.ATTR_NAME) {
      attrs.push(this._consumeAttr(this._advance()));
    }
    var fullName = elementName(prefix, name, this._getParentElement());
    var voidElement = false;
    // Note: There could have been a tokenizer error
    // so that we don't get a token for the end tag...
    if (this.peek.type === HtmlTokenType.TAG_OPEN_END_VOID) {
      this._advance();
      voidElement = true;
    } else if (this.peek.type === HtmlTokenType.TAG_OPEN_END) {
      this._advance();
      voidElement = false;
    }
    var end = this.peek.sourceSpan.start;
    var el = new HtmlElementAst(fullName, attrs, [],
                                new ParseSourceSpan(startTagToken.sourceSpan.start, end));
    this._pushElement(el);
    if (voidElement) {
      this._popElement(fullName);
    }
  }

  private _pushElement(el: HtmlElementAst) {
    var stackIndex = this.elementStack.length - 1;
    while (stackIndex >= 0) {
      var parentEl = this.elementStack[stackIndex];
      if (!getHtmlTagDefinition(parentEl.name).isClosedByChild(el.name)) {
        break;
      }
      stackIndex--;
    }
    this.elementStack.splice(stackIndex, this.elementStack.length - 1 - stackIndex);

    var tagDef = getHtmlTagDefinition(el.name);
    var parentEl = this._getParentElement();
    if (tagDef.requireExtraParent(isPresent(parentEl) ? parentEl.name : null)) {
      var newParent = new HtmlElementAst(tagDef.requiredParent, [], [el], el.sourceSpan);
      this._addToParent(newParent);
      this.elementStack.push(newParent);
      this.elementStack.push(el);
    } else {
      this._addToParent(el);
      this.elementStack.push(el);
    }
  }

  private _consumeEndTag(endTagToken: HtmlToken) {
    var fullName =
        elementName(endTagToken.parts[0], endTagToken.parts[1], this._getParentElement());
    if (!this._popElement(fullName)) {
      this.errors.push(HtmlTreeError.create(HtmlTreeErrorType.UnexpectedClosingTag, fullName,
                                            endTagToken.sourceSpan.start));
    }
  }

  private _popElement(fullName: string): boolean {
    var stackIndex = this.elementStack.length - 1;
    var hasError = false;
    while (stackIndex >= 0) {
      var el = this.elementStack[stackIndex];
      if (el.name == fullName) {
        break;
      }
      if (!getHtmlTagDefinition(el.name).closedByParent) {
        hasError = true;
        break;
      }
      stackIndex--;
    }
    if (!hasError) {
      this.elementStack.splice(stackIndex, this.elementStack.length - stackIndex);
    }
    return !hasError;
  }

  private _consumeAttr(attrName: HtmlToken): HtmlAttrAst {
    var fullName = elementName(attrName.parts[0], attrName.parts[1], null);
    var end = attrName.sourceSpan.end;
    var value = '';
    if (this.peek.type === HtmlTokenType.ATTR_VALUE) {
      var valueToken = this._advance();
      value = valueToken.parts[0];
      end = valueToken.sourceSpan.end;
    }
    return new HtmlAttrAst(fullName, value, new ParseSourceSpan(attrName.sourceSpan.start, end));
  }

  private _getParentElement(): HtmlElementAst {
    return this.elementStack.length > 0 ? ListWrapper.last(this.elementStack) : null;
  }

  private _addToParent(node: HtmlAst) {
    var parent = this._getParentElement();
    if (isPresent(parent)) {
      parent.children.push(node);
    } else {
      this.rootNodes.push(node);
    }
  }
}

function elementName(prefix: string, localName: string, parentElement: HtmlElementAst) {
  if (isBlank(prefix)) {
    prefix = getHtmlTagDefinition(localName).implicitNamespacePrefix;
  }
  if (isBlank(prefix) && isPresent(parentElement)) {
    prefix = namespacePrefix(parentElement.name);
  }
  if (isPresent(prefix)) {
    return `@${prefix}:${localName}`;
  } else {
    return localName;
  }
}

function namespacePrefix(elementName: string): string {
  var match = RegExpWrapper.firstMatch(NS_PREFIX_RE, elementName);
  return isBlank(match) ? null : match[1];
}